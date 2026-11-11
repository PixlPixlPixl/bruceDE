import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BackendPluginAPI } from '@brucede/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import { AcpClient, AcpConnection, type AcpModelInfo, type AcpPromptUsage } from '../acp.js';
import { PiRpcConnection } from '../pi-rpc.js';
import { executableExists } from '../spawn.js';
import type {
    AgentCapabilities,
    AgentCommand,
    AgentDescriptor,
    AgentModelInfo,
    AgentModelState,
    AgentProtocol,
    AgentSessionsService,
    AgentState,
    AgentUsageInfo,
    ChatEntry
} from '../shared.js';

/** Transcripts are capped so a long session cannot flood the RPC channel. */
const MAX_ENTRIES = 400;
/** Models returned by one `searchModels` call when the caller does not say. */
const DEFAULT_MODEL_LIMIT = 40;
/** Pi lists thousands of models; a picker never needs more than this. */
const MAX_MODEL_LIMIT = 200;
/** Shell passthrough may run as long as a real build; the poll keeps the UI live. */
const SHELL_TIMEOUT_MS = 300_000;
/** Bounded so an attachment cannot blow up the agent's context window. */
const MAX_ATTACHMENT_BYTES = 200_000;
const MAX_ATTACHMENTS_BYTES = 400_000;

/**
 * Agent CLIs this plugin knows how to drive.
 *
 * Entries carry their availability: the picker shows installed agents in full
 * colour and the rest dimmed, so the user can see what this build supports
 * without being able to launch something that is not there. Any ACP agent can
 * also be added without a code change through `BRUCEDE_AGENTS`.
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

/** One model as Pi reports it (`get_state`, `get_available_models`). */
interface PiModel {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly provider?: unknown;
    readonly contextWindow?: unknown;
}

/** `get_state` payload; only the fields this panel reads are named. */
interface PiState {
    readonly model?: PiModel;
    readonly thinkingLevel?: unknown;
}

/** `get_session_stats` payload. */
interface PiStats {
    readonly tokens?: {
        readonly input?: unknown;
        readonly output?: unknown;
        readonly cacheRead?: unknown;
        readonly cacheWrite?: unknown;
        readonly total?: unknown;
    };
    readonly cost?: unknown;
    readonly contextUsage?: {
        readonly tokens?: unknown;
        readonly contextWindow?: unknown;
        readonly percent?: unknown;
    };
}

/** Result of Pi's `bash` command. */
interface PiBashResult {
    readonly output?: unknown;
    readonly exitCode?: unknown;
    readonly cancelled?: unknown;
    readonly truncated?: unknown;
    readonly fullOutputPath?: unknown;
}

/** Output of one shell command, as the panel records it. */
interface ShellResult {
    readonly text: string;
    readonly failed: boolean;
}

/**
 * Capabilities a protocol exposes beyond prompting.
 *
 * Everything here is optional *by protocol*, not by claim: an agent that lists
 * no models simply has no model picker, one that never reports usage has no
 * usage chips, and ACP agents have no shell passthrough unless they add one.
 */
interface AgentIntrospection {
    /** Current model, thinking level and the models on offer. */
    refreshModels(): Promise<AgentModelState | undefined>;
    /** Token accounting of the session, when the agent reports it. */
    refreshUsage(): Promise<AgentUsageInfo | undefined>;
    /** Commands the agent accepts as `/name`. */
    refreshCommands(): Promise<readonly AgentCommand[]>;
    selectModel(model: AgentModelInfo): Promise<void>;
    selectThinking?(level: string): Promise<void>;
    shell?(command: string): Promise<ShellResult>;
}

/**
 * One running agent conversation, protocol-independent.
 *
 * The session bookkeeping (status, transcript, error handling) is identical for
 * both protocols, so it lives in one place and each protocol only has to
 * implement start/prompt/cancel/dispose plus whatever introspection it supports.
 */
interface AgentLink {
    readonly alive: boolean;
    /** Announces the prompt; resolves once the agent accepted it. */
    prompt(text: string): Promise<void>;
    /** Asks the agent to stop the current turn. */
    cancel(): void;
    /** Releases the child process. */
    dispose(): void;
    readonly capabilities: AgentCapabilities;
    readonly introspect?: AgentIntrospection;
}

interface LiveSession {
    readonly sessionId: string;
    agentId: string;
    agent?: AgentDescriptor;
    link?: AgentLink;
    status: AgentState['status'];
    entries: ChatEntry[];
    error?: string;
    cwd: string;
    model?: AgentModelState;
    usage?: AgentUsageInfo;
    commands: readonly AgentCommand[];
    /** Models of the current agent, kept for `searchModels` and `selectModel`. */
    models: readonly AgentModelInfo[];
    /** State of the transcript under streaming updates. */
    streamingText: boolean;
}

/**
 * Backend half of agent-chat: one child process per chat session.
 *
 * Session ids are panel instance ids, so two open chat tabs never share a
 * transcript or a process. It publishes `agent.sessions` so the renderer can
 * list agents, bind a session, read the transcript and send a prompt. Every
 * child process is disposed when its session is released or the plugin unloads.
 */
export function activate(api: BackendPluginAPI): void {
    const agents = discoverAgents();
    const cwd = api.workspace.cwd;
    const sessions = new Map<string, LiveSession>();

    const agentById = (agentId: string): AgentDescriptor => {
        const agent = agents.find(candidate => candidate.id === agentId);
        if (!agent) {
            throw new Error(`Unknown agent "${agentId}".`);
        }
        return agent;
    };

    const snapshot = (session: LiveSession): AgentState => ({
        agentId: session.agentId,
        status: session.status,
        entries: [...session.entries],
        error: session.error,
        cwd: session.cwd,
        capabilities: session.link?.capabilities,
        model: session.model,
        usage: session.usage,
        commands: session.commands
    });

    const sessionFor = (sessionId: string): LiveSession => {
        const existing = sessions.get(sessionId);
        if (existing) {
            return existing;
        }
        // A restored panel can ask for its state before it re-binds; an unknown
        // session is simply empty, not an error.
        const created: LiveSession = {
            sessionId,
            agentId: '',
            status: 'idle',
            entries: [],
            cwd,
            commands: [],
            models: [],
            streamingText: false
        };
        sessions.set(sessionId, created);
        return created;
    };

    const service: AgentSessionsService = {
        listAgents: () => agents,

        openSession: async (sessionId, agentId) => {
            const agent = agentById(agentId);
            const session = sessionFor(sessionId);
            if (session.agentId === agentId) {
                return snapshot(session);
            }
            // Switching agents on an existing tab must not leave the previous
            // child running or its transcript behind.
            session.link?.dispose();
            session.link = undefined;
            session.agentId = agentId;
            session.agent = agent;
            session.entries = [];
            session.status = 'idle';
            session.error = undefined;
            session.streamingText = false;
            session.model = undefined;
            session.usage = undefined;
            session.commands = [];
            session.models = [];
            // Start straight away: the model and command labels are only
            // meaningful once the agent is up, and the user opened this tab to
            // talk to it. The process is released when the tab closes.
            if (executableExists(agent.command)) {
                void ensureStarted(session, cwd)
                    .then(async link => {
                        await refreshIntrospection(session, link);
                        // `ensureStarted` marks the session `starting`; a start
                        // that succeeds without a prompt must settle back to idle,
                        // or `send` would refuse the first message.
                        if (session.status === 'starting') {
                            session.status = 'idle';
                        }
                    })
                    .catch(error => failSession(session, error));
            }
            return snapshot(session);
        },

        state: async sessionId => snapshot(sessionFor(sessionId)),

        send: async (sessionId, text) => {
            const session = sessionFor(sessionId);
            if (!session.agent) {
                throw new Error('This chat has no agent yet. Pick one with the + button.');
            }
            if (session.status === 'running' || session.status === 'starting') {
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
                return snapshot(session);
            }
            pushEntry(session, { role: 'user', text });
            session.streamingText = false;
            session.status = 'running';
            session.error = undefined;
            const prompt = await inlineMentions(text, session);
            void runTurn(session, prompt).catch(() => undefined);
            return snapshot(session);
        },

        cancel: async sessionId => {
            const session = sessionFor(sessionId);
            if (session.link) {
                session.link.cancel();
                pushEntry(session, { role: 'system', text: 'Turn cancelled.' });
            }
            session.status = 'idle';
            return snapshot(session);
        },

        reset: async sessionId => {
            const session = sessionFor(sessionId);
            session.link?.dispose();
            session.link = undefined;
            session.entries = [];
            session.status = 'idle';
            session.error = undefined;
            session.streamingText = false;
            session.usage = undefined;
            return snapshot(session);
        },

        release: async sessionId => {
            const session = sessions.get(sessionId);
            if (!session) {
                return;
            }
            session.link?.dispose();
            sessions.delete(sessionId);
        },

        searchModels: async (sessionId, query, limit) => {
            const session = sessionFor(sessionId);
            const capped = Math.min(Math.max(limit ?? DEFAULT_MODEL_LIMIT, 1), MAX_MODEL_LIMIT);
            const needle = query.trim().toLowerCase();
            const matches = needle
                ? session.models.filter(model => modelSearchText(model).includes(needle))
                : session.models;
            return matches.slice(0, capped);
        },

        selectModel: async (sessionId, modelKey) => {
            const session = sessionFor(sessionId);
            const model = session.models.find(candidate => candidate.key === modelKey);
            if (!model) {
                throw new Error('That model is not offered by the connected agent.');
            }
            const introspect = session.link?.introspect;
            if (!introspect) {
                throw new Error('The agent is not running yet; model selection needs a live session.');
            }
            await guard(session, async () => {
                await introspect.selectModel(model);
                await refreshIntrospection(session, session.link);
            });
            return snapshot(session);
        },

        selectThinking: async (sessionId, level) => {
            const session = sessionFor(sessionId);
            const introspect = session.link?.introspect;
            if (!introspect?.selectThinking) {
                throw new Error('The connected agent does not expose thinking levels.');
            }
            await guard(session, async () => {
                await introspect.selectThinking!(level);
                await refreshIntrospection(session, session.link);
            });
            return snapshot(session);
        },

        runShell: async (sessionId, command) => {
            const session = sessionFor(sessionId);
            const introspect = session.link?.introspect;
            if (!introspect?.shell) {
                throw new Error('The connected agent has no shell passthrough.');
            }
            const trimmed = command.trim();
            if (!trimmed) {
                return snapshot(session);
            }
            if (session.status === 'running' || session.status === 'starting') {
                throw new Error('This agent is still answering the previous prompt.');
            }
            pushEntry(session, { role: 'user', text: `! ${trimmed}` });
            session.status = 'running';
            session.error = undefined;
            void runShellTurn(session, trimmed).catch(() => undefined);
            return snapshot(session);
        }
    };

    api.services.provide(WORKSPACE_SERVICE_IDS.agentSessions, service);

    // Native handles are invisible to Cordis; the plugin must release them itself.
    api.onDispose(() => {
        for (const session of sessions.values()) {
            session.link?.dispose();
        }
    });

    /** Runs one shell command through the agent and records the result. */
    async function runShellTurn(session: LiveSession, command: string): Promise<void> {
        const introspect = session.link?.introspect;
        if (!introspect?.shell) {
            failSession(session, new Error('The connected agent has no shell passthrough.'));
            return;
        }
        try {
            const result = await introspect.shell(command);
            pushEntry(session, { role: 'tool', text: result.text });
            session.status = result.failed ? 'error' : 'idle';
            session.error = result.failed ? `"${command}" failed.` : undefined;
            await refreshUsage(session);
        } catch (error) {
            failSession(session, error);
        }
    }

    /** Starts the child (if needed) and runs exactly one prompt turn. */
    async function runTurn(session: LiveSession, prompt: string): Promise<void> {
        try {
            const link = await ensureStarted(session, session.cwd);
            await link.prompt(prompt);
            // ACP resolves the prompt when the turn ends; Pi answers as soon as
            // it accepts the prompt and reports completion through events, so it
            // keeps the session `running` until `agent_settled`.
            if (session.agent?.protocol === 'acp') {
                session.status = 'idle';
                await refreshUsage(session);
            }
        } catch (error) {
            failSession(session, error);
        }
    }

    /** Reads whatever the link can report; missing pieces stay absent. */
    async function refreshIntrospection(session: LiveSession, link: AgentLink | undefined): Promise<void> {
        const introspect = link?.introspect;
        if (!introspect) {
            return;
        }
        const model = await introspect.refreshModels().catch(() => undefined);
        if (model) {
            session.model = { ...model, modelCount: session.models.length };
        }
        session.commands = await introspect.refreshCommands().catch(() => session.commands);
        await refreshUsage(session);
    }

    async function refreshUsage(session: LiveSession): Promise<void> {
        const usage = await session.link?.introspect?.refreshUsage().catch(() => undefined);
        if (usage) {
            session.usage = usage;
        }
    }

    async function ensureStarted(session: LiveSession, workingDirectory: string): Promise<AgentLink> {
        if (session.link?.alive) {
            return session.link;
        }
        session.link?.dispose();
        session.link = undefined;
        session.status = 'starting';

        const agent = session.agent;
        if (!agent) {
            throw new Error('This chat has no agent yet.');
        }

        const link = agent.protocol === 'pi-rpc'
            ? await startPi(session, agent, workingDirectory)
            : await startAcp(session, agent, workingDirectory);
        session.link = link;
        return link;
    }

    async function startAcp(
        session: LiveSession,
        agent: AgentDescriptor,
        workingDirectory: string
    ): Promise<AgentLink> {
        let sessionId: string | undefined;
        let modelState: AgentModelState | undefined;
        let commands: AgentCommand[] = [];
        let lastUsage: AgentUsageInfo | undefined;
        let client: AcpClient | undefined;
        const connection = new AcpConnection(agent.command, agent.args, workingDirectory, {
            notification: (method, params) => {
                if (method === 'session/update') {
                    const update = params.update as Record<string, unknown> | undefined;
                    if (update?.sessionUpdate === 'available_commands_update') {
                        commands = parseAcpCommands(update);
                        session.commands = commands;
                        return;
                    }
                    appendAcpUpdate(session, params);
                }
            },
            request: async (method, params) => requestFromAgent(method, params),
            exit: reason => handleExit(session, reason)
        });
        client = new AcpClient(connection);
        const initialized = await client.initialize();
        if (initialized.authMethods && initialized.authMethods.length > 0) {
            const methods = initialized.authMethods.map(method => method.name ?? method.id).join(', ');
            connection.dispose();
            throw new Error(
                `"${agent.name}" requires authentication (${methods}). `
                + 'Log in with that agent CLI first, then reopen this chat.'
            );
        }
        const created = await client.newSession(workingDirectory);
        sessionId = created.sessionId;
        if (created.models?.availableModels?.length) {
            modelState = {
                current: created.models.currentModelId
                    ? toAcpModel(created.models.currentModelId, created.models.availableModels)
                    : undefined,
                modelCount: created.models.availableModels.length
            };
            session.models = created.models.availableModels
                .map(info => toAcpModelInfo(info))
                .filter((info): info is AgentModelInfo => info !== undefined);
        }
        const live = client;
        return {
            get alive() {
                return connection.alive;
            },
            prompt: async text => {
                const result = await live.prompt(sessionId!, text);
                lastUsage = acpUsage(result.usage);
            },
            cancel: () => live.cancel(sessionId!),
            dispose: () => connection.dispose(),
            capabilities: { shell: false },
            introspect: {
                refreshModels: async () => modelState,
                refreshUsage: async () => lastUsage,
                refreshCommands: async () => commands,
                selectModel: async model => {
                    if (!session.models.length) {
                        throw new Error(`"${agent.name}" did not offer any models.`);
                    }
                    await live.setModel(sessionId!, model.modelId);
                    modelState = { ...modelState, current: model, modelCount: session.models.length };
                }
            }
        };
    }

    async function startPi(
        session: LiveSession,
        agent: AgentDescriptor,
        workingDirectory: string
    ): Promise<AgentLink> {
        const connection = new PiRpcConnection(agent.command, agent.args, workingDirectory, {
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

        const loadModels = async (): Promise<AgentModelInfo[]> => {
            const result = await connection.request<{ models?: readonly PiModel[] }>({
                type: 'get_available_models'
            });
            const models = (result?.models ?? [])
                .map(candidate => toPiModelInfo(candidate))
                .filter((candidate): candidate is AgentModelInfo => candidate !== undefined);
            session.models = models;
            return models;
        };

        return {
            get alive() {
                return connection.alive;
            },
            prompt: async text => {
                await connection.prompt(text);
            },
            cancel: () => connection.abort(),
            dispose: () => connection.dispose(),
            capabilities: { shell: true },
            introspect: {
                refreshModels: async () => {
                    const state = await connection.request<PiState>({ type: 'get_state' });
                    const levels = await connection.request<{ levels?: readonly string[] }>({
                        type: 'get_available_thinking_levels'
                    });
                    const models = await loadModels();
                    return {
                        current: toPiModelInfo(state?.model ?? {}),
                        thinking: readString(state?.thinkingLevel),
                        thinkingLevels: (levels?.levels ?? []).filter(level => typeof level === 'string'),
                        modelCount: models.length
                    };
                },
                refreshUsage: async () => piUsage(await connection.request<PiStats>({ type: 'get_session_stats' })),
                refreshCommands: async () => {
                    const result = await connection.request<{ commands?: readonly Record<string, unknown>[] }>({
                        type: 'get_commands'
                    });
                    return (result?.commands ?? []).map(command => ({
                        name: readString(command.name) ?? '',
                        description: readString(command.description),
                        source: readString(command.source)
                    })).filter(command => command.name !== '');
                },
                selectModel: async model => {
                    await connection.request({
                        type: 'set_model',
                        provider: model.provider ?? '',
                        modelId: model.modelId
                    });
                },
                selectThinking: async level => {
                    await connection.request({ type: 'set_thinking_level', level });
                },
                shell: async command => {
                    const result = await connection.request<PiBashResult>(
                        { type: 'bash', command },
                        SHELL_TIMEOUT_MS
                    );
                    const output = readString(result?.output) ?? '';
                    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : undefined;
                    const lines = [`$ ${command}`];
                    if (output.trim()) {
                        lines.push(output.trimEnd());
                    }
                    if (result?.truncated === true) {
                        const full = readString(result?.fullOutputPath);
                        lines.push(full ? `(truncated; full output: ${full})` : '(truncated)');
                    }
                    lines.push(exitCode === undefined ? '(no exit code)' : `(exit ${exitCode})`);
                    return { text: lines.join('\n'), failed: (exitCode ?? 0) !== 0 };
                }
            }
        };
    }

    function handleExit(session: LiveSession, reason: string): void {
        session.link?.dispose();
        session.link = undefined;
        failSession(session, new Error(reason));
    }

    function failSession(session: LiveSession, error: unknown): void {
        session.status = 'error';
        session.error = describeError(error);
        pushEntry(session, { role: 'system', text: session.error });
    }

    /** Runs an operation that can fail, surfacing the error in the transcript. */
    async function guard(session: LiveSession, operation: () => Promise<void>): Promise<void> {
        try {
            await operation();
        } catch (error) {
            failSession(session, error);
            throw error;
        }
    }

    /**
     * Inlines `@path` mentions into the prompt.
     *
     * The agent's interactive mode expands `@file` itself, but its RPC mode does
     * not (`prompt` rejects `@file` arguments), so the plugin attaches the file
     * content here. Anything that cannot be attached is reported in the
     * transcript instead of silently disappearing.
     */
    async function inlineMentions(text: string, session: LiveSession): Promise<string> {
        const mentions = [...text.matchAll(/@([^\s@]+)/g)]
            .map(match => match[1])
            .filter((value, index, all) => all.indexOf(value) === index);
        if (mentions.length === 0) {
            return text;
        }
        const attachments: string[] = [];
        let budget = MAX_ATTACHMENTS_BYTES;
        for (const mention of mentions) {
            const resolved = path.isAbsolute(mention) ? mention : path.resolve(session.cwd, mention);
            try {
                const content = await readFile(resolved, 'utf8');
                if (content.includes('\u0000')) {
                    pushEntry(session, { role: 'system', text: `@${mention} is binary; not attached.` });
                    continue;
                }
                if (content.length > MAX_ATTACHMENT_BYTES || content.length > budget) {
                    pushEntry(session, { role: 'system', text: `@${mention} is too large to attach.` });
                    continue;
                }
                budget -= content.length;
                attachments.push(`<file path="${mention}">\n${content}\n</file>`);
            } catch {
                // A missing file is not fatal: the agent may create it, and its
                // tools can still see the mention in the prompt text.
                pushEntry(session, { role: 'system', text: `@${mention} could not be read; left as text.` });
            }
        }
        if (attachments.length === 0) {
            return text;
        }
        return `${attachments.join('\n\n')}\n\n${text}`;
    }
}

/** Lower-case text a model can be found by: name, id and provider. */
function modelSearchText(model: AgentModelInfo): string {
    return `${model.name} ${model.modelId} ${model.provider ?? ''}`.toLowerCase();
}

function toPiModelInfo(candidate: PiModel): AgentModelInfo | undefined {
    const modelId = readString(candidate.id);
    if (!modelId) {
        return undefined;
    }
    const provider = readString(candidate.provider);
    return {
        key: `${provider ?? ''}:${modelId}`,
        name: readString(candidate.name) ?? modelId,
        provider,
        modelId,
        contextWindow: typeof candidate.contextWindow === 'number' ? candidate.contextWindow : undefined
    };
}

function toAcpModelInfo(info: AcpModelInfo): AgentModelInfo | undefined {
    const modelId = readString(info.modelId) ?? readString(info.id);
    if (!modelId) {
        return undefined;
    }
    return {
        key: `acp:${modelId}`,
        name: readString(info.name) ?? modelId,
        modelId
    };
}

function toAcpModel(modelId: string, available: readonly AcpModelInfo[]): AgentModelInfo | undefined {
    const match = available.find(candidate => readString(candidate.modelId) === modelId);
    return match ? toAcpModelInfo(match) : { key: `acp:${modelId}`, name: modelId, modelId };
}

function parseAcpCommands(update: Record<string, unknown>): AgentCommand[] {
    const available = Array.isArray(update.availableCommands) ? update.availableCommands : [];
    return available.map(entry => {
        const record = entry as Record<string, unknown>;
        return {
            name: readString(record.name) ?? '',
            description: readString(record.description),
            source: 'acp'
        };
    }).filter(command => command.name !== '');
}

/** `get_session_stats` → the two numbers the footer shows. */
function piUsage(stats: PiStats | undefined): AgentUsageInfo | undefined {
    if (!stats) {
        return undefined;
    }
    const tokens = stats.tokens;
    const input = readNumber(tokens?.input);
    const cacheRead = readNumber(tokens?.cacheRead);
    const context = stats.contextUsage;
    const contextTokens = readNumber(context?.tokens);
    const cacheHitPercent = (input !== undefined && cacheRead !== undefined && input + cacheRead > 0)
        ? (cacheRead / (input + cacheRead)) * 100
        : undefined;
    return {
        contextTokens: contextTokens ?? null,
        contextWindow: readNumber(context?.contextWindow),
        contextPercent: readNumber(context?.percent) ?? null,
        cacheHitPercent,
        totalTokens: readNumber(tokens?.total),
        cost: readNumber(stats.cost)
    };
}

/** ACP reports prompt usage only when its version supports it. */
function acpUsage(usage: AcpPromptUsage | undefined): AgentUsageInfo | undefined {
    if (!usage) {
        return undefined;
    }
    const input = readNumber(usage.inputTokens);
    const cacheRead = readNumber(usage.cachedReadTokens);
    const total = readNumber(usage.totalTokens);
    const cacheHitPercent = (input !== undefined && cacheRead !== undefined && input + cacheRead > 0)
        ? (cacheRead / (input + cacheRead)) * 100
        : undefined;
    if (total === undefined && cacheHitPercent === undefined) {
        return undefined;
    }
    return { totalTokens: total, cacheHitPercent };
}

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

/**
 * Agents come from `BRUCEDE_AGENTS` (authoritative; `BRUCEDE_ACP_AGENTS` is
 * still accepted as its old name) or the known list.
 * The environment variable is a JSON array of `{ id, name, command, args?, protocol? }`.
 */
function discoverAgents(): AgentDescriptor[] {
    const configured = readConfiguredAgents();
    if (configured) {
        // An explicit configuration is the user's decision: list every entry, so
        // a missing binary is reported instead of silently disappearing.
        return configured.map(candidate => toDescriptor(candidate, executableExists(candidate.command)));
    }
    // Nothing configured: every supported agent is listed with its availability,
    // so the picker can show installed agents first and the rest as unavailable.
    return KNOWN_AGENTS.map(candidate => toDescriptor(candidate, executableExists(candidate.command)));
}

function toDescriptor(candidate: AgentCandidate, available: boolean): AgentDescriptor {
    return {
        id: candidate.id,
        name: candidate.name,
        protocol: candidate.protocol,
        command: candidate.command,
        args: candidate.args ?? [],
        available
    };
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

function readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
