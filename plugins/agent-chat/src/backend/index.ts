import { accessSync, constants, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import type { BackendPluginAPI } from '@brucede/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import { AcpClient, AcpConnection } from '../acp.js';
import type { AgentDescriptor, AgentSessionsService, AgentState, ChatEntry } from '../shared.js';

/** Transcripts are capped so a long session cannot flood the RPC channel. */
const MAX_ENTRIES = 400;

/**
 * ACP-capable CLIs this plugin knows how to launch. The `initialize` handshake
 * is the real availability check; `available` only reports whether the binary
 * exists, so a changed flag surfaces as an ACP error in the transcript instead
 * of a silent failure.
 */
const KNOWN_AGENTS: readonly Omit<AgentDescriptor, 'available'>[] = [
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
    { id: 'claude-code-acp', name: 'Claude Code (ACP)', command: 'claude-code-acp', args: [] },
    { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] }
];

interface LiveSession {
    readonly agent: AgentDescriptor;
    connection?: AcpConnection;
    client?: AcpClient;
    sessionId?: string;
    status: AgentState['status'];
    entries: ChatEntry[];
    error?: string;
}

/**
 * Backend half of agent-chat: an ACP client per installed agent.
 *
 * It publishes `agent.sessions` so the renderer can list agents, read the
 * transcript and send a prompt. Every child process is killed when the plugin
 * unloads.
 */
export function activate(api: BackendPluginAPI): void {
    const agents = discoverAgents();
    const cwd = api.workspace.cwd;
    const sessions = new Map<string, LiveSession>();

    for (const agent of agents) {
        sessions.set(agent.id, { agent, status: 'idle', entries: [] });
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
            session.status = 'running';
            session.error = undefined;
            void runTurn(session, cwd, text).catch(() => undefined);
            return state(agentId);
        },

        cancel: async agentId => {
            const session = requireSession(sessions, agentId);
            if (session.client && session.sessionId) {
                session.client.cancel(session.sessionId);
                pushEntry(session, { role: 'system', text: 'Turn cancelled.' });
            }
            session.status = 'idle';
            return state(agentId);
        },

        reset: async agentId => {
            const session = requireSession(sessions, agentId);
            session.connection?.dispose();
            sessions.set(agentId, { agent: session.agent, status: 'idle', entries: [] });
            return state(agentId);
        }
    };

    api.services.provide(WORKSPACE_SERVICE_IDS.agentSessions, service);

    // Native handles are invisible to Cordis; the plugin must release them itself.
    api.onDispose(() => {
        for (const session of sessions.values()) {
            session.connection?.dispose();
        }
    });

    /** Starts the child (if needed) and runs exactly one prompt turn. */
    async function runTurn(session: LiveSession, workingDirectory: string, text: string): Promise<void> {
        try {
            await ensureStarted(session, workingDirectory);
            const client = session.client;
            const sessionId = session.sessionId;
            if (!client || !sessionId) {
                throw new Error('ACP session was not established.');
            }
            await client.prompt(sessionId, text);
            session.status = 'idle';
        } catch (error) {
            session.status = 'error';
            session.error = describeError(error);
            pushEntry(session, { role: 'system', text: session.error });
        }
    }

    async function ensureStarted(session: LiveSession, workingDirectory: string): Promise<void> {
        if (session.connection?.alive && session.client && session.sessionId) {
            return;
        }
        session.status = 'starting';
        const connection = new AcpConnection(session.agent.command, session.agent.args, workingDirectory, {
            notification: (method, params) => {
                if (method === 'session/update') {
                    appendUpdate(session, params);
                }
            },
            request: async (method, params) => requestFromAgent(method, params),
            exit: reason => {
                connection.dispose();
                session.connection = undefined;
                session.client = undefined;
                session.sessionId = undefined;
                session.status = 'error';
                session.error = reason;
                pushEntry(session, { role: 'system', text: reason });
            }
        });
        session.connection = connection;

        const client = new AcpClient(connection);
        const initialized = await client.initialize();
        if (initialized.authMethods && initialized.authMethods.length > 0) {
            const methods = initialized.authMethods.map(method => method.name ?? method.id).join(', ');
            throw new Error(
                `"${session.agent.name}" requires authentication (${methods}). `
                + 'Log in with that agent CLI first, then reopen this panel.'
            );
        }
        session.sessionId = await client.newSession(workingDirectory);
        session.client = client;
    }
}

/** Rewrites `session/update` notifications into transcript entries. */
function appendUpdate(session: LiveSession, params: Record<string, unknown>): void {
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
        const last = session.entries[session.entries.length - 1];
        if (last && last.role === 'agent' && !last.text.endsWith('\n\n')) {
            // Streamed chunks form one message; append instead of adding rows.
            session.entries[session.entries.length - 1] = { role: 'agent', text: last.text + text };
            return;
        }
        pushEntry(session, { role: 'agent', text });
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

function contentText(content: unknown): string | undefined {
    if (typeof content !== 'object' || content === null) {
        return undefined;
    }
    const record = content as Record<string, unknown>;
    return typeof record.text === 'string' ? record.text : undefined;
}

/**
 * Answers requests the agent makes back to us.
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
 * Agents come from `BRUCEDE_ACP_AGENTS` (authoritative) or the known list.
 * The environment variable is a JSON array of `{ id, name, command, args? }`.
 */
function discoverAgents(): AgentDescriptor[] {
    const configured = readConfiguredAgents();
    const candidates = configured ?? KNOWN_AGENTS;
    return candidates.map(candidate => ({
        id: candidate.id,
        name: candidate.name,
        command: candidate.command,
        args: candidate.args ?? [],
        available: executableExists(candidate.command)
    }));
}

function readConfiguredAgents(): Omit<AgentDescriptor, 'available'>[] | undefined {
    const raw = process.env.BRUCEDE_ACP_AGENTS;
    if (!raw || !raw.trim()) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return undefined;
        }
        const agents: Omit<AgentDescriptor, 'available'>[] = [];
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
                command,
                args
            });
        }
        return agents.length > 0 ? agents : undefined;
    } catch {
        return undefined;
    }
}

/** True when `command` is an executable file on `PATH` (or an absolute path). */
function executableExists(command: string): boolean {
    const candidates = command.includes('/')
        ? [command]
        : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, command));
    for (const candidate of candidates) {
        try {
            const stats = statSync(candidate);
            if (!stats.isFile()) {
                continue;
            }
            accessSync(candidate, constants.X_OK);
            return true;
        } catch {
            // Keep probing the remaining PATH entries.
        }
    }
    return false;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
