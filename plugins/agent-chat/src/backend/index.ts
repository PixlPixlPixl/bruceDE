import type { BackendPluginAPI } from '@brucede/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import { AcpClient, AcpConnection } from '../acp.js';
import { PiRpcConnection } from '../pi-rpc.js';
import { executableExists } from '../spawn.js';
import type {
    AgentDescriptor,
    AgentProtocol,
    AgentSessionsService,
    AgentState,
    ChatEntry
} from '../shared.js';

/** Transcripts are capped so a long session cannot flood the RPC channel. */
const MAX_ENTRIES = 400;

/**
 * Agent CLIs this plugin knows how to drive.
 *
 * Two protocols are supported, because the ecosystem is not uniform: most agents
 * speak ACP, Pi speaks its own RPC mode and has no ACP mode. The handshake is the
 * real availability check; `available` only reports whether the binary resolves,
 * so a changed flag surfaces as a protocol error in the transcript instead of a
 * silent failure.
 */
const KNOWN_AGENTS: readonly AgentCandidate[] = [
    { id: 'pi', name: 'Pi', protocol: 'pi-rpc', command: 'pi', args: ['--mode', 'rpc', '--no-session'] },
    { id: 'gemini', name: 'Gemini CLI', protocol: 'acp', command: 'gemini', args: ['--experimental-acp'] },
    { id: 'claude-code-acp', name: 'Claude Code (ACP)', protocol: 'acp', command: 'claude-code-acp', args: [] },
    { id: 'opencode', name: 'OpenCode', protocol: 'acp', command: 'opencode', args: ['acp'] }
];

type AgentCandidate = Omit<AgentDescriptor, 'available'>;

/**
 * One running agent conversation, protocol-independent.
 *
 * The session bookkeeping (status, transcript, error handling) is identical for
 * both protocols, so it lives in one place and each protocol only has to
 * implement start/prompt/cancel/dispose.
 */
interface AgentLink {
    readonly alive: boolean;
    /** Announces the prompt; resolves once the agent accepted it. */
    prompt(text: string): Promise<void>;
    /** Asks the agent to stop the current turn. */
    cancel(): void;
    /** Releases the child process. */
    dispose(): void;
}

interface LiveSession {
    readonly agent: AgentDescriptor;
    link?: AgentLink;
    status: AgentState['status'];
    entries: ChatEntry[];
    error?: string;
    /** State of the transcript under streaming updates. */
    streamingText: boolean;
}

/**
 * Backend half of agent-chat: one child process per installed agent.
 *
 * It publishes `agent.sessions` so the renderer can list agents, read the
 * transcript and send a prompt. Every child process is disposed when the plugin
 * unloads.
 */
export function activate(api: BackendPluginAPI): void {
    const agents = discoverAgents();
    const cwd = api.workspace.cwd;
    const sessions = new Map<string, LiveSession>();

    for (const agent of agents) {
        sessions.set(agent.id, { agent, status: 'idle', entries: [], streamingText: false });
    }

    const state = (agentId: string): AgentState => {
        const session = requireSession(sessions, agentId);
        return {
            agentId,
            status: session.status,
            entries: [...session.entries],
            error: session.error
        };
    };

    const service: AgentSessionsService = {
        listAgents: () => agents,
        state,

        send: async (agentId, text) => {
            const session = requireSession(sessions, agentId);
            if (session.status === 'running') {
                throw new Error('This agent is still answering the previous prompt.');
            }
            // Re-probe at send time: the user may have installed the CLI since
            // the plugin activated, and a stale `available` must not make the
            // panel claim the agent works.
            if (!executableExists(session.agent.command)) {
                session.status = 'error';
                session.error = `"${session.agent.command}" was not found on PATH.`;
                pushEntry(session, { role: 'user', text });
                pushEntry(session, { role: 'system', text: session.error });
                return state(agentId);
            }
            pushEntry(session, { role: 'user', text });
            session.streamingText = false;
            session.status = 'running';
            session.error = undefined;
            void runTurn(session, cwd, text).catch(() => undefined);
            return state(agentId);
        },

        cancel: async agentId => {
            const session = requireSession(sessions, agentId);
            if (session.link) {
                session.link.cancel();
                pushEntry(session, { role: 'system', text: 'Turn cancelled.' });
            }
            session.status = 'idle';
            return state(agentId);
        },

        reset: async agentId => {
            const session = requireSession(sessions, agentId);
            session.link?.dispose();
            sessions.set(agentId, { agent: session.agent, status: 'idle', entries: [], streamingText: false });
            return state(agentId);
        }
    };

    api.services.provide(WORKSPACE_SERVICE_IDS.agentSessions, service);

    // Native handles are invisible to Cordis; the plugin must release them itself.
    api.onDispose(() => {
        for (const session of sessions.values()) {
            session.link?.dispose();
        }
    });

    /** Starts the child (if needed) and runs exactly one prompt turn. */
    async function runTurn(session: LiveSession, workingDirectory: string, text: string): Promise<void> {
        try {
            const link = await ensureStarted(session, workingDirectory);
            await link.prompt(text);
            // ACP resolves the prompt when the turn ends; Pi answers as soon as
            // it accepts the prompt and reports completion through events, so it
            // keeps the session `running` until `agent_settled`.
            if (session.agent.protocol === 'acp') {
                session.status = 'idle';
            }
        } catch (error) {
            session.status = 'error';
            session.error = describeError(error);
            pushEntry(session, { role: 'system', text: session.error });
        }
    }

    async function ensureStarted(session: LiveSession, workingDirectory: string): Promise<AgentLink> {
        if (session.link?.alive) {
            return session.link;
        }
        session.link?.dispose();
        session.link = undefined;
        session.status = 'starting';

        const link = session.agent.protocol === 'pi-rpc'
            ? await startPi(session, workingDirectory)
            : await startAcp(session, workingDirectory);
        session.link = link;
        return link;
    }

    async function startAcp(session: LiveSession, workingDirectory: string): Promise<AgentLink> {
        const connection = new AcpConnection(session.agent.command, session.agent.args, workingDirectory, {
            notification: (method, params) => {
                if (method === 'session/update') {
                    appendAcpUpdate(session, params);
                }
            },
            request: async (method, params) => requestFromAgent(method, params),
            exit: reason => handleExit(session, reason)
        });
        const client = new AcpClient(connection);
        const initialized = await client.initialize();
        if (initialized.authMethods && initialized.authMethods.length > 0) {
            const methods = initialized.authMethods.map(method => method.name ?? method.id).join(', ');
            connection.dispose();
            throw new Error(
                `"${session.agent.name}" requires authentication (${methods}). `
                + 'Log in with that agent CLI first, then reopen this panel.'
            );
        }
        const sessionId = await client.newSession(workingDirectory);
        return {
            get alive() {
                return connection.alive;
            },
            prompt: async text => {
                await client.prompt(sessionId, text);
            },
            cancel: () => client.cancel(sessionId),
            dispose: () => connection.dispose()
        };
    }

    async function startPi(session: LiveSession, workingDirectory: string): Promise<AgentLink> {
        const connection = new PiRpcConnection(session.agent.command, session.agent.args, workingDirectory, {
            event: record => appendPiEvent(session, record),
            uiRequest: record => answerPiUiRequest(session, connection, record),
            exit: reason => handleExit(session, reason)
        });
        try {
            await connection.start();
        } catch (error) {
            connection.dispose();
            throw error;
        }
        return {
            get alive() {
                return connection.alive;
            },
            prompt: async text => {
                await connection.prompt(text);
            },
            cancel: () => connection.abort(),
            dispose: () => connection.dispose()
        };
    }

    function handleExit(session: LiveSession, reason: string): void {
        session.link?.dispose();
        session.link = undefined;
        session.status = 'error';
        session.error = reason;
        pushEntry(session, { role: 'system', text: reason });
    }
}

/** Rewrites ACP `session/update` notifications into transcript entries. */
function appendAcpUpdate(session: LiveSession, params: Record<string, unknown>): void {
    const update = params.update as Record<string, unknown> | undefined;
    if (!update || typeof update.sessionUpdate !== 'string') {
        return;
    }
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const text = contentText(update.content);
        if (!text) {
            return;
        }
        if (kind === 'agent_thought_chunk') {
            pushEntry(session, { role: 'system', text: `thought: ${text}` });
            return;
        }
        appendAgentText(session, text);
        return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
        const title = typeof update.title === 'string' ? update.title : undefined;
        const status = typeof update.status === 'string' ? update.status : undefined;
        const label = [title, status].filter(Boolean).join(' — ');
        if (label) {
            pushEntry(session, { role: 'tool', text: `tool: ${label}` });
        }
        return;
    }

    if (kind === 'plan') {
        const entries = Array.isArray(update.entries) ? update.entries.length : 0;
        pushEntry(session, { role: 'system', text: `plan: ${entries} step(s)` });
    }
}

/**
 * Rewrites Pi RPC session events into the same transcript entries.
 *
 * Only assistant text, tool activity and turn boundaries are surfaced: Pi also
 * streams system, user and extension ("custom") messages, which would duplicate
 * what the panel already shows or expose internal prompt assembly.
 */
function appendPiEvent(session: LiveSession, record: Record<string, unknown>): void {
    const type = typeof record.type === 'string' ? record.type : undefined;

    if (type === 'message_update') {
        const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
        const kind = typeof event?.type === 'string' ? event.type : undefined;
        if (kind === 'text_delta' && typeof event?.delta === 'string') {
            appendAgentText(session, event.delta);
            return;
        }
        if (kind === 'error' && typeof event?.error === 'string') {
            pushEntry(session, { role: 'system', text: `agent error: ${event.error}` });
        }
        return;
    }

    if (type === 'tool_execution_start') {
        const name = typeof record.toolName === 'string' ? record.toolName : 'tool';
        pushEntry(session, { role: 'tool', text: `tool: ${name}` });
        return;
    }

    if (type === 'tool_execution_end') {
        if (record.isError === true) {
            const name = typeof record.toolName === 'string' ? record.toolName : 'tool';
            pushEntry(session, { role: 'tool', text: `tool: ${name} failed` });
        }
        return;
    }

    if (type === 'agent_settled') {
        if (record.aborted === true) {
            pushEntry(session, { role: 'system', text: 'Turn aborted.' });
        }
        session.status = 'idle';
        session.error = undefined;
        session.streamingText = false;
    }
}

/**
 * Answers Pi extension UI requests.
 *
 * Fire-and-forget methods (`setStatus`, `notify`, …) are ignored except for
 * notifications, which go into the transcript. Dialog methods block Pi until
 * answered, and this panel has no dialog UI yet, so they are cancelled — and
 * recorded, so nothing happens silently.
 */
function answerPiUiRequest(
    session: LiveSession,
    connection: PiRpcConnection,
    record: Record<string, unknown>
): void {
    const id = typeof record.id === 'string' ? record.id : undefined;
    const method = typeof record.method === 'string' ? record.method : undefined;
    if (!id || !method) {
        return;
    }
    if (method === 'notify') {
        const message = typeof record.message === 'string' ? record.message : undefined;
        if (message) {
            pushEntry(session, { role: 'system', text: `agent notice: ${message}` });
        }
        return;
    }
    if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
        const title = typeof record.title === 'string' ? record.title : method;
        pushEntry(session, { role: 'system', text: `agent asked: ${title} — dismissed (no dialog UI yet)` });
        connection.answerUiRequest(id, { cancelled: true });
    }
}

/** Streams text into the trailing agent entry, or starts a new one. */
function appendAgentText(session: LiveSession, text: string): void {
    const last = session.entries[session.entries.length - 1];
    if (last && last.role === 'agent' && session.streamingText) {
        session.entries[session.entries.length - 1] = { role: 'agent', text: last.text + text };
        return;
    }
    pushEntry(session, { role: 'agent', text });
    session.streamingText = true;
}

function contentText(content: unknown): string | undefined {
    if (typeof content !== 'object' || content === null) {
        return undefined;
    }
    const record = content as Record<string, unknown>;
    return typeof record.text === 'string' ? record.text : undefined;
}

/**
 * Answers requests an ACP agent makes back to us.
 *
 * This client advertises no filesystem or terminal capability, so those fail
 * loudly. Permission prompts are auto-approved for the least invasive allow
 * option because there is no permission UI yet — the decision is recorded in
 * the transcript so it is never silent.
 */
async function requestFromAgent(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'session/request_permission') {
        const options = Array.isArray(params.options) ? params.options : [];
        const allow = options.find(option => {
            const kind = (option as Record<string, unknown>).kind;
            return kind === 'allow_once' || kind === 'allow_always' || kind === 'allow';
        }) as Record<string, unknown> | undefined;
        if (allow && typeof allow.optionId === 'string') {
            return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        }
        return { outcome: { outcome: 'cancelled' } };
    }
    throw new Error(`Unsupported ACP client method "${method}".`);
}

function pushEntry(session: LiveSession, entry: ChatEntry): void {
    session.entries.push(entry);
    if (session.entries.length > MAX_ENTRIES) {
        session.entries.splice(0, session.entries.length - MAX_ENTRIES);
    }
}

function requireSession(sessions: Map<string, LiveSession>, agentId: string): LiveSession {
    const session = sessions.get(agentId);
    if (!session) {
        throw new Error(`Unknown agent "${agentId}".`);
    }
    return session;
}

/**
 * Agents come from `BRUCEDE_AGENTS` (authoritative; `BRUCEDE_ACP_AGENTS` is
 * still accepted as its old name) or the known list.
 * The environment variable is a JSON array of `{ id, name, command, args?, protocol? }`.
 */
function discoverAgents(): AgentDescriptor[] {
    const configured = readConfiguredAgents();
    const candidates = configured ?? KNOWN_AGENTS;
    return candidates.map(candidate => ({
        id: candidate.id,
        name: candidate.name,
        protocol: candidate.protocol,
        command: candidate.command,
        args: candidate.args ?? [],
        available: executableExists(candidate.command)
    }));
}

function readConfiguredAgents(): AgentCandidate[] | undefined {
    const raw = process.env.BRUCEDE_AGENTS ?? process.env.BRUCEDE_ACP_AGENTS;
    if (!raw || !raw.trim()) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return undefined;
        }
        const agents: AgentCandidate[] = [];
        for (const entry of parsed) {
            if (typeof entry !== 'object' || entry === null) {
                continue;
            }
            const record = entry as Record<string, unknown>;
            const command = typeof record.command === 'string' ? record.command : undefined;
            if (!command) {
                continue;
            }
            const args = Array.isArray(record.args)
                ? record.args.filter((arg): arg is string => typeof arg === 'string')
                : [];
            agents.push({
                id: typeof record.id === 'string' ? record.id : command,
                name: typeof record.name === 'string' ? record.name : command,
                protocol: isProtocol(record.protocol) ? record.protocol : 'acp',
                command,
                args
            });
        }
        return agents.length > 0 ? agents : undefined;
    } catch {
        return undefined;
    }
}

function isProtocol(value: unknown): value is AgentProtocol {
    return value === 'acp' || value === 'pi-rpc';
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
