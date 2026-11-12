import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BackendPluginAPI } from '@icebox/plugin-api';
import {
    AGENT_PROTOCOL_LABELS,
    WORKSPACE_EVENT_IDS,
    WORKSPACE_SERVICE_IDS,
    isAgentProtocol,
    type WorkspacePluginsService
} from '@icebox/plugin-api';
import { AcpClient, AcpConnection, type AcpModelInfo, type AcpPromptUsage } from '../acp.js';
import { AgUiConnection, agUiId, probeAgUi, type AgUiEvent, type AgUiMessage } from '../agui.js';
import { PiRpcConnection } from '../pi-rpc.js';
import { executableExists } from '../spawn.js';
import type {
    AgentCapabilities,
    AgentCommand,
    AgentDescriptor,
    AgentModelInfo,
    AgentModelState,
    AgentProtocol,
    AgentRuntimeService,
    AgentRuntimeState,
    AgentSessionHandle,
    AgentSessionOptions,
    AgentSessionSummary,
    AgentUsageInfo,
    AgUiEvent as RuntimeEvent,
    ChatEntry
} from '@icebox/plugin-api';

/**
 * The event log is capped so a long session cannot flood the RPC channel.
 */
const MAX_EVENTS = 400;

/**
 * How long one `waitForChange` stays pending.
 *
 * It is a ceiling, not a poll interval: a change answers at once, and the timeout
 * only stops a request from living forever on a silent session. The holder asks
 * again.
 */
const CHANGE_TIMEOUT_MS = 20_000;
/** Models returned by one `searchModels` call when the caller does not say. */
const DEFAULT_MODEL_LIMIT = 40;
/** Pi lists thousands of models; a picker never needs more than this. */
const MAX_MODEL_LIMIT = 200;
/** Shell passthrough may run as long as a real build; the poll keeps the UI live. */
const SHELL_TIMEOUT_MS = 300_000;
/** Bounded so an attachment cannot blow up the agent's context window. */
const MAX_ATTACHMENT_BYTES = 200_000;
const MAX_ATTACHMENTS_BYTES = 400_000;

/** How long a `PATH` answer is reused; the panel re-polls the list every second. */
const AVAILABILITY_TTL_MS = 2_000;

/**
 * Where the agents come from.
 *
 * Agents are plugin data, not a list compiled into this panel: each one is
 * declared by a plugin's manifest (`contributes.agents`), read through
 * {@link WORKSPACE_SERVICE_IDS.plugins}. Adding an agent is therefore dropping a
 * plugin folder in, and removing one is disabling (or deleting) that plugin — no
 * source edit either way. `ICEBOX_AGENTS` remains as the escape hatch for an
 * unlisted agent, and replaces the catalogue entirely when set, because an explicit
 * configuration is the user's decision.
 *
 * Three protocols are supported, because the ecosystem is not uniform: AG-UI is
 * the panel's preferred interface, most agents speak ACP, and Pi speaks its own
 * RPC mode and has no ACP mode. Which one a session uses is decided at start: an
 * agent with an AG-UI endpoint is tried over AG-UI first, and its own protocol is
 * the fallback when the endpoint does not answer.
 *
 * Availability is a question about *this machine*, answered here: an agent with
 * an AG-UI endpoint is available as soon as it is declared (the endpoint is probed
 * at start), and a CLI agent is available when its binary resolves on `PATH`. The
 * handshake is the real check either way, so a changed flag surfaces as a protocol
 * error in the transcript instead of a silent failure.
 */
/**
 * An agent before this machine's availability is known.
 *
 * `command` is optional because an agent may exist only behind an AG-UI
 * endpoint; `toDescriptor` normalises it to an empty string so the rest of the
 * backend never has to ask whether a launch command exists.
 */
type AgentCandidate = {
    id: string;
    name: string;
    protocol: AgentDescriptor['protocol'];
    command?: string;
    args?: readonly string[];
    agui?: string;
};

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
    readonly sessionFile?: unknown;
    readonly sessionId?: unknown;
    readonly sessionName?: unknown;
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
    /**
     * Hands a message to the agent mid-turn (`midTurn: 'steer'`).
     * Absent for protocols without a steering channel.
     */
    steer?(text: string): Promise<void>;
    /** Starts a fresh agent session, backing the agent's own `/new`. */
    newSession?(): Promise<void>;
    /** Token accounting of the session, when the agent reports it. */
    refreshUsage?(): Promise<AgentUsageInfo | undefined>;
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
 * implement start/prompt/dispose plus whatever introspection it supports.
 */
interface AgentLink {
    readonly alive: boolean;
    /** Announces the prompt; resolves once the agent accepted it. */
    prompt(text: string): Promise<void>;
    /** Stops the turn in flight; the conversation survives. */
    interrupt?(): void;
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
    status: AgentRuntimeState['status'];
    /**
     * The AG-UI events this session has emitted, oldest first.
     *
     * `eventsBase` counts events dropped from the front once the log hits
     * `MAX_EVENTS`, so a cursor a consumer holds stays meaningful across a trim:
     * it addresses `eventsBase + index`, not an array position.
     */
    events: RuntimeEvent[];
    eventsBase: number;
    /** Message id of the assistant entry currently streaming, when there is one. */
    messageId?: string;
    /** First line of the first prompt, kept for session lists. */
    title?: string;
    error?: string;
    cwd: string;
    model?: AgentModelState;
    usage?: AgentUsageInfo;
    commands: readonly AgentCommand[];
    /** Models of the current agent, kept for `searchModels` and `selectModel`. */
    models: readonly AgentModelInfo[];
    /** Messages waiting for the current turn to end (`midTurn: 'queue'`). */
    queue: string[];
    /** State of the transcript under streaming updates. */
    streamingText: boolean;
    /** The agent's own session handle, once it has started. */
    resume?: AgentSessionHandle;
    /**
     * Protocol the live link speaks.
     *
     * Set when the link starts: `agui` when an AG-UI endpoint answered,
     * otherwise the agent's own. Cleared when a link is disposed.
     */
    protocol?: AgentProtocol;
    /** Why a configured AG-UI endpoint was not used, for the panel's label. */
    aguiUnavailable?: string;
    /** Keep the agent's conversation on disk so a later resume can find it. */
    persist: boolean;
    /** True while a native session loads and its history is being replayed. */
    replaying: boolean;
    /**
     * A stop the user asked for is in flight.
     *
     * Protocols end a cancelled turn differently — ACP resolves its prompt, Pi
     * settles with `aborted`, an AG-UI run rejects because its request was
     * dropped — so the flag tells the turn runner that the rejection is expected
     * rather than a failure worth surfacing as an error state.
     */
    interrupted?: boolean;
    /** ISO timestamp of the last state change, for the session summary. */
    updatedAt: string;
    /**
     * True when this chat shares its agent process with another chat.
     *
     * Set by the ACP driver: `session/new` on a live process costs a request, and
     * a project list is a better place to show "shared" than a hidden refcount.
     */
    linkShared?: boolean;
    /**
     * Bumped by `touch()`, so every state change is observable even when it emits
     * no event. `waitForChange` waits on this; the event cursor cannot serve,
     * because a status flip appends nothing to the log.
     */
    revision: number;
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
    // Manifest-declared agents come from other plugins, which this plugin cannot
    // read on its own; the host publishes them through `workspace.plugins`.
    const catalogue = api.services.get<WorkspacePluginsService>(WORKSPACE_SERVICE_IDS.plugins);
    const agents = (): Promise<AgentDescriptor[]> => discoverAgents(catalogue);
    const cwd = api.workspace.cwd;
    const sessions = new Map<string, LiveSession>();

    const agentById = async (agentId: string): Promise<AgentDescriptor> => {
        const agent = (await agents()).find(candidate => candidate.id === agentId);
        if (!agent) {
            throw new Error(`Unknown agent "${agentId}".`);
        }
        return agent;
    };

    const snapshot = (session: LiveSession, since = 0): AgentRuntimeState => ({
        sessionId: session.sessionId,
        agentId: session.agentId,
        status: session.status,
        protocol: session.protocol,
        error: session.error,
        cwd: session.cwd,
        capabilities: session.link?.capabilities,
        model: session.model,
        usage: session.usage,
        commands: session.commands,
        resume: session.resume,
        title: session.title,
        // A consumer asks for what it has not seen: everything before `since`
        // already reached it, and a trim must not shift its place.
        events: session.events.slice(Math.max(0, since - session.eventsBase)),
        cursor: session.eventsBase + session.events.length,
        revision: session.revision
    });

    const now = (): string => new Date().toISOString();

    /**
     * Records a state change and tells workspace plugins (Projects) about it.
     *
     * The payload is just the id: a listener that wants details asks
     * `summary()`, so transcripts never travel on the shared event bus.
     */
    /**
     * Announces a state change: to workspace listeners and to whichever panels are
     * holding a `waitForChange` open.
     */
    const touch = (session: LiveSession): void => {
        session.updatedAt = now();
        session.revision += 1;
        api.events.emit(WORKSPACE_EVENT_IDS.agentSessionChanged, { sessionId: session.sessionId });
        wakeWaiters(session);
    };

    const summaryOf = (session: LiveSession): AgentSessionSummary => ({
        sessionId: session.sessionId,
        agentId: session.agentId,
        status: session.status,
        live: true,
        cwd: session.cwd,
        title: session.title,
        resume: session.resume,
        updatedAt: session.updatedAt
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
            events: [],
            eventsBase: 0,
            cwd,
            commands: [],
            models: [],
            queue: [],
            streamingText: false,
            persist: false,
            replaying: false,
            updatedAt: now(),
            revision: 0
        };
        sessions.set(sessionId, created);
        return created;
    };

    const service: AgentRuntimeService = {
        listAgents: () => agents(),

        open: async (sessionId: string, agentId: string, options?: AgentSessionOptions) => {
            const agent = await agentById(agentId);
            const session = sessionFor(sessionId);
            // A handle for another agent would resume the wrong process; the
            // panel only ever passes the handle that belongs to its agent.
            const resume = options?.resume && options.resume.agentId === agentId ? options.resume : undefined;
            const workingDirectory = options?.cwd ? path.resolve(options.cwd) : session.cwd;
            if (session.agentId === agentId) {
                // A second caller can address the same logical session (a project
                // list resuming a session that is still open). Reuse the live
                // link rather than starting a second process on the same agent
                // session file, which would corrupt it.
                if (session.link?.alive || resume === undefined) {
                    return snapshot(session);
                }
            }
            // Switching agents on an existing tab must not leave the previous
            // child running or its transcript behind.
            session.link?.dispose();
            session.link = undefined;
            session.agentId = agentId;
            session.agent = agent;
            resetEvents(session);
            session.status = 'idle';
            session.error = undefined;
            session.streamingText = false;
            session.model = undefined;
            session.usage = undefined;
            session.commands = [];
            session.models = [];
            session.queue = [];
            session.cwd = workingDirectory;
            session.resume = resume;
            // Persisting is what makes a later resume possible at all: a project
            // chat keeps its session on disk, a plain chat stays ephemeral.
            session.persist = resume !== undefined || options?.cwd !== undefined;
            session.replaying = false;
            touch(session);
            // Start straight away: the model and command labels are only
            // meaningful once the agent is up, and the user opened this tab to
            // talk to it. The process is released when the tab closes.
            if (agentCanStart(agent)) {
                void ensureStarted(session, session.cwd)
                    .then(async link => {
                        await refreshIntrospection(session, link);
                        // `ensureStarted` marks the session `starting`; a start
                        // that succeeds without a prompt must settle back to idle,
                        // or `send` would refuse the first message.
                        if (session.status === 'starting') {
                            session.status = 'idle';
                        }
                        touch(session);
                    })
                    .catch(error => failSession(session, error));
            }
            return snapshot(session);
        },

        state: async (sessionId, since) => snapshot(sessionFor(sessionId), since ?? 0),

        waitForChange: async (sessionId, since, timeoutMs = CHANGE_TIMEOUT_MS) => {
            const session = sessionFor(sessionId);
            if (session.revision > since) {
                return session.revision;
            }
            return new Promise<number>(resolve => {
                // A timeout answers with the unchanged revision, which tells the
                // caller "wait again" without a second kind of result.
                const wait = (revision: number): void => {
                    clearTimeout(timer);
                    resolve(revision);
                };
                const timer = setTimeout(() => {
                    const set = waiters.get(sessionId);
                    set?.delete(wait);
                    if (set && set.size === 0) {
                        waiters.delete(sessionId);
                    }
                    resolve(session.revision);
                }, timeoutMs);
                let set = waiters.get(sessionId);
                if (!set) {
                    set = new Set();
                    waiters.set(sessionId, set);
                }
                set.add(wait);
            });
        },

        summary: async sessionId => {
            const live = sessions.get(sessionId);
            if (!live) {
                return { sessionId, agentId: '', status: 'idle', live: false };
            }
            return summaryOf(live);
        },

        listSessions: async () => [...sessions.values()].map(session => summaryOf(session)),

        send: async (sessionId, text) => {
            const session = sessionFor(sessionId);
            if (!session.agent) {
                throw new Error('This chat has no agent yet. Pick one with the + button.');
            }
            if (session.status === 'starting') {
                throw new Error('The agent is still connecting; try again in a moment.');
            }
            // The panel has no Reset button: a fresh session is the agent's own
            // `/new` or a new tab. Pi exposes it as an RPC command, not as one of
            // its discoverable slash commands, so it is handled here.
            if (
                session.status !== 'running'
                && text.trim() === '/new'
                && (session.agent.protocol === 'pi-rpc' || session.agent.agui !== undefined)
            ) {
                const introspect = session.link?.introspect;
                if (!introspect?.newSession) {
                    throw new Error('The agent is not started yet; /new needs a live session.');
                }
                const previous = session.resume;
                await guard(session, async () => {
                    await introspect.newSession!();
                    resetEvents(session);
                    session.queue = [];
                    session.usage = undefined;
                    session.streamingText = false;
                    // `/new` replaces the agent-side conversation. An agent that
                    // reports the session it created (Pi, AG-UI) has already
                    // replaced the handle; one that does not leaves a stale handle
                    // behind, and resuming it later would reopen the old chat.
                    session.resume = session.resume && session.resume.sessionId !== previous?.sessionId
                        ? session.resume
                        : undefined;
                    await refreshIntrospection(session, session.link);
                });
                pushEntry(session, { role: 'system', text: 'Started a new agent session.' });
                touch(session);
                return snapshot(session);
            }
            if (session.status === 'running') {
                await midTurnMessage(session, text);
                return snapshot(session);
            }
            // Re-probe at send time: the user may have installed the CLI since
            // the plugin activated, and a stale `available` must not make the
            // panel claim the agent works.
            if (!agentCanStart(session.agent)) {
                session.status = 'error';
                session.error = `"${session.agent.command}" was not found on PATH and no AG-UI endpoint is configured.`;
                pushEntry(session, { role: 'user', text });
                pushEntry(session, { role: 'system', text: session.error });
                touch(session);
                return snapshot(session);
            }
            pushEntry(session, { role: 'user', text });
            session.streamingText = false;
            session.status = 'running';
            session.error = undefined;
            // The first prompt is what gives a project's session list its title.
            touch(session);
            const prompt = await inlineMentions(text, session);
            void runTurn(session, prompt).catch(() => undefined);
            return snapshot(session);
        },

        interrupt: async sessionId => {
            // Looked up, not created: a stop on a session that was never started
            // has nothing to stop and must not manufacture one.
            const session = sessions.get(sessionId);
            if (!session || (session.status !== 'running' && session.status !== 'starting')) {
                return session
                    ? snapshot(session)
                    : { sessionId, agentId: '', status: 'idle', events: [], cursor: 0, revision: 0 };
            }
            const link = session.link;
            if (!link?.interrupt) {
                // Nothing to cancel, or the protocol cannot stop mid-turn: say so
                // instead of pretending the stop happened.
                pushEntry(session, {
                    role: 'system',
                    text: session.status === 'starting'
                        ? 'Wait for the agent to finish starting before stopping the turn.'
                        : 'This agent cannot stop a turn that is already running.'
                });
                touch(session);
                return snapshot(session);
            }
            session.interrupted = true;
            link.interrupt();
            const discarded = session.queue.length;
            // "Stop" means stop: a queued message would otherwise be sent the moment
            // the turn ends, so the user would have stopped nothing.
            session.queue = [];
            const plural = discarded === 1 ? 'message' : 'messages';
            pushEntry(session, {
                role: 'system',
                text: discarded > 0
                    ? `Turn interrupted; ${discarded} queued ${plural} discarded.`
                    : 'Turn interrupted.'
            });
            touch(session);
            return snapshot(session);
        },

        release: async sessionId => {
            const session = sessions.get(sessionId);
            if (!session) {
                return;
            }
            session.link?.dispose();
            session.link = undefined;
            session.status = 'idle';
            // Tell listeners before the record disappears: a project list keeps
            // the last known status/handle of a closed tab.
            touch(session);
            waiters.delete(sessionId);
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
                // The guard above proved this exists; re-read it for the call so the
                // assertion is not needed.
                const select = introspect.selectThinking;
                if (select) {
                    await select(level);
                }
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

    api.services.provide(WORKSPACE_SERVICE_IDS.agentRuntime, service);

    // A driver owns child processes, and Cordis disposes the fiber, not raw Node
    // handles: without this, disabling the plugin in the manager would leave
    // `pi`/`gemini` children running with no panel able to reach them.
    api.onDispose(() => {
        for (const session of sessions.values()) {
            session.link?.dispose();
        }
        sessions.clear();
    });

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
            touch(session);
        } catch (error) {
            failSession(session, error);
        }
    }

    /** Starts the child (if needed) and runs exactly one prompt turn. */
    async function runTurn(session: LiveSession, prompt: string): Promise<void> {
        try {
            const link = await ensureStarted(session, session.cwd);
            await link.prompt(prompt);
            // ACP resolves the prompt when the turn ends, and an AG-UI run resolves
            // when its event stream closes, which is the same boundary. Pi answers
            // as soon as it accepts the prompt and reports completion through
            // events, so it keeps the session `running` until `agent_settled`.
            if (session.protocol !== 'pi-rpc') {
                session.status = 'idle';
                await refreshUsage(session);
            }
            drainQueue(session);
            touch(session);
        } catch (error) {
            if (session.interrupted) {
                // The protocol rejecting here is the stop working, not a fault.
                session.interrupted = false;
                session.status = 'idle';
                session.error = undefined;
                touch(session);
                return;
            }
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
        const introspect = session.link?.introspect;
        // Usage is optional per protocol: an AG-UI endpoint reports none.
        if (!introspect?.refreshUsage) {
            return;
        }
        const usage = await introspect.refreshUsage().catch(() => undefined);
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
        session.protocol = undefined;
        session.status = 'starting';

        const agent = session.agent;
        if (!agent) {
            throw new Error('This chat has no agent yet.');
        }

        const link = await connectAgent(session, agent, workingDirectory);
        session.link = link;
        return link;
    }

    /**
     * Opens the agent over AG-UI when it answers, and over its own protocol when
     * it does not.
     *
     * AG-UI is the panel's primary interface, so it is what an agent with a
     * configured endpoint is tried with first. The liveness check is cheap and
     * side-effect free, which is what makes a fallback possible without costing
     * the user a turn: a dead endpoint is discovered before anything is sent to
     * it. An agent that has no endpoint, or whose endpoint stays silent, keeps
     * working exactly as before through ACP or Pi's RPC mode.
     */
    async function connectAgent(
        session: LiveSession,
        agent: AgentDescriptor,
        workingDirectory: string
    ): Promise<AgentLink> {
        const endpoint = agent.agui;
        if (!endpoint) {
            return startNative(session, agent, workingDirectory);
        }
        const answering = await probeAgUi(endpoint).catch(() => false);
        if (answering) {
            session.protocol = 'agui';
            // The endpoint may have been down earlier in this session's life.
            session.aguiUnavailable = undefined;
            return startAgUi(session, agent, endpoint);
        }
        if (!agent.command) {
            throw new Error(
                `"${agent.name}" is reachable only over AG-UI, and ${endpoint} is not answering.`
            );
        }
        session.aguiUnavailable = `The AG-UI endpoint ${endpoint} is not answering.`;
        // The fallback is announced rather than silent: the panel's protocol
        // label then says ACP, and this entry says why it is not AG-UI.
        pushEntry(session, {
            role: 'system',
            text: `${session.aguiUnavailable} Using ${AGENT_PROTOCOL_LABELS[agent.protocol]} instead.`
        });
        return startNative(session, agent, workingDirectory);
    }

    /** Starts the agent over its own protocol: ACP, or Pi's RPC mode. */
    async function startNative(
        session: LiveSession,
        agent: AgentDescriptor,
        workingDirectory: string
    ): Promise<AgentLink> {
        session.protocol = agent.protocol;
        return agent.protocol === 'pi-rpc'
            ? startPi(session, agent, workingDirectory)
            : startAcp(session, agent, workingDirectory);
    }

    /**
     * Opens a live AG-UI conversation.
     *
     * There is no child process here: a turn is one HTTP request whose response
     * streams the run's events, so `prompt` resolves when that stream closes —
     * the equivalent of ACP resolving its `session/prompt`. AG-UI has no shell
     * passthrough and no mid-turn steering channel, and it reports no model list
     * or token accounting, so the link has no model picker and no usage chips.
     *
     * The thread id *is* the resume handle. AG-UI keeps a conversation on its side
     * under that id, which is why continuing an earlier chat reuses it; `/new`
     * mints a fresh one, which is the protocol's way of starting a conversation
     * over without deleting the old thread.
     */
    async function startAgUi(
        session: LiveSession,
        agent: AgentDescriptor,
        endpoint: string
    ): Promise<AgentLink> {
        const connection = new AgUiConnection(endpoint, {
            event: event => appendAgUiEvent(session, event)
        });
        const newThread = (): string => {
            const threadId = agUiId('thread');
            session.resume = { agentId: agent.id, protocol: 'agui', sessionId: threadId };
            touch(session);
            return threadId;
        };
        if (session.resume?.protocol !== 'agui') {
            newThread();
        }
        return {
            get alive() {
                return connection.alive;
            },
            prompt: async text => {
                const threadId = session.resume?.protocol === 'agui'
                    ? session.resume.sessionId
                    : newThread();
                await connection.run(threadId, messageHistory(session, text), {
                    agentId: agent.id,
                    cwd: session.cwd
                });
            },
            interrupt: () => connection.abort(),
            dispose: () => connection.dispose(),
            capabilities: { shell: false, midTurn: 'queue', interrupt: true },
            introspect: {
                // AG-UI has no introspection surface: a server reports state as
                // events during a run, not on request.
                refreshModels: async () => undefined,
                refreshCommands: async () => [],
                selectModel: async () => {
                    throw new Error('AG-UI endpoints report no model list.');
                },
                newSession: async () => {
                    newThread();
                }
            }
        };
    }

    /**
     * One ACP agent process, which several chat sessions can share.
     *
     * ACP addresses every call by session id and allows `session/new` again on
     * the same connection, so a second chat on the same agent costs a request
     * instead of a process. Everything the connection reports is routed back by
     * session id, which is what makes the sharing safe: no chat sees another's
     * turns, commands or usage.
     */
    interface AcpHost {
        readonly key: string;
        readonly agent: AgentDescriptor;
        readonly connection: AcpConnection;
        readonly client: AcpClient;
        /** Whether `initialize` advertised `session/load`. */
        readonly supportsLoad: boolean;
        /** Sessions bound to this process, by the agent's own session id. */
        readonly routes: Map<string, AcpRoute>;
        /**
         * Routes whose `session/new` has not returned yet.
         *
         * An agent may announce commands, or replay history during `session/load`,
         * before the id is known — so a notification is matched by id first and
         * falls back to the single opening route. Two chats opening at once is
         * ambiguous by nature, and is left unrouted rather than delivered to the
         * wrong chat.
         */
        readonly opening: AcpRoute[];
        /** How many chat sessions are holding this process open. */
        refs: number;
        alive: boolean;
    }

    interface AcpRoute {
        readonly session: LiveSession;
        /** Usage and command lists are per session, so they are stored per route. */
        setUsage(usage: AgentUsageInfo | undefined): void;
        setCommands(commands: readonly AgentCommand[]): void;
    }

    const acpHosts = new Map<string, AcpHost>();

    /**
     * Which process a session may share.
     *
     * Keyed by agent and working folder, because the folder is fixed when the
     * process starts. Pi never reaches here: its RPC commands carry no session
     * parameter and `new_session` replaces the one conversation a process holds,
     * so it always gets a process of its own. AG-UI has no process at all.
     */
    const acpKey = (agent: AgentDescriptor, workingDirectory: string): string =>
        `acp:${agent.id}:${workingDirectory}`;

    /** The live process for this agent and folder, or a freshly started one. */
    async function acquireAcpHost(
        session: LiveSession,
        agent: AgentDescriptor,
        workingDirectory: string
    ): Promise<AcpHost> {
        const key = acpKey(agent, workingDirectory);
        const existing = acpHosts.get(key);
        if (existing?.alive) {
            existing.refs += 1;
            session.linkShared = true;
            return existing;
        }

        // Built in two steps: the connection's handlers need the host they belong
        // to, and the host needs the connection to exist.
        let host: AcpHost;
        const routes = new Map<string, AcpRoute>();
        const opening: AcpRoute[] = [];
        const connection = new AcpConnection(agent.command, agent.args, workingDirectory, {
            notification: (method, params) => {
                if (method !== 'session/update') {
                    return;
                }
                const byId = typeof params.sessionId === 'string' ? routes.get(params.sessionId) : undefined;
                // Before `session/new` answers, the only chat that can be speaking
                 // is the one opening it.
                const target = byId ?? (opening.length === 1 ? opening[0] : undefined);
                if (!target) {
                    return;
                }
                const update = params.update as Record<string, unknown> | undefined;
                if (update?.sessionUpdate === 'available_commands_update') {
                    target.setCommands(parseAcpCommands(update));
                    return;
                }
                appendAcpUpdate(target.session, params);
            },
            request: async (method, params) => requestFromAgent(method, params),
            exit: reason => {
                // One process, several chats: an exit belongs to all of them.
                host.alive = false;
                acpHosts.delete(host.key);
                const bound = [...host.routes.values()];
                host.routes.clear();
                for (const route of bound) {
                    handleExit(route.session, reason);
                }
            }
        });
        const client = new AcpClient(connection);
        const initialized = await client.initialize();
        if (initialized.authMethods && initialized.authMethods.length > 0) {
            connection.dispose();
            const methods = initialized.authMethods.map(method => method.name ?? method.id).join(', ');
            throw new Error(
                `"${agent.name}" requires authentication (${methods}). `
                + 'Log in with that agent CLI first, then reopen this chat.'
            );
        }
        host = {
            key,
            agent,
            connection,
            client,
            supportsLoad: isLoadSessionSupported(initialized.agentCapabilities),
            routes,
            opening,
            refs: 1,
            alive: true
        };
        acpHosts.set(key, host);
        return host;
    }

    /** Drops one chat's claim; the process dies with the last one. */
    function releaseAcpHost(host: AcpHost, session: LiveSession): void {
        host.refs -= 1;
        session.linkShared = false;
        if (host.refs > 0) {
            return;
        }
        acpHosts.delete(host.key);
        host.alive = false;
        host.connection.dispose();
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
        const host = await acquireAcpHost(session, agent, workingDirectory);
        const client = host.client;
        const connection = host.connection;

        const resume = session.resume;
        const supportsLoad = host.supportsLoad;
        const route: AcpRoute = {
            session,
            setUsage: usage => {
                lastUsage = usage;
            },
            setCommands: next => {
                commands = [...next];
                session.commands = commands;
            }
        };
        if (resume && supportsLoad) {
            // Registered before the request: `session/load` replays the earlier
            // conversation through notifications while the call is outstanding.
            host.routes.set(resume.sessionId, route);
            // Native resume: the agent replays the conversation through
            // `session/update` notifications, so the transcript is rebuilt from
            // the same events a live turn produces.
            session.replaying = true;
            try {
                const loaded = await client.loadSession(resume.sessionId, workingDirectory);
                sessionId = resume.sessionId;
                session.resume = { agentId: agent.id, protocol: 'acp', sessionId };
                if (loaded.models?.availableModels?.length) {
                    modelState = {
                        current: loaded.models.currentModelId
                            ? toAcpModel(loaded.models.currentModelId, loaded.models.availableModels)
                            : undefined,
                        modelCount: loaded.models.availableModels.length
                    };
                    session.models = loaded.models.availableModels
                        .map(info => toAcpModelInfo(info))
                        .filter((info): info is AgentModelInfo => info !== undefined);
                }
            } finally {
                session.replaying = false;
            }
        } else {
            if (resume) {
                pushEntry(session, {
                    role: 'system',
                    text: `"${agent.name}" cannot restore an earlier session; started a new one.`
                });
            }
            // The id is not known until the answer, so this route is matched by
            // being the only one opening.
            host.opening.push(route);
            let created;
            try {
                created = await client.newSession(workingDirectory);
            } finally {
                // Either way the open is over: a route must not stay "pending" and
                // silently receive another chat's notifications.
                const index = host.opening.indexOf(route);
                if (index >= 0) {
                    host.opening.splice(index, 1);
                }
            }
            sessionId = created.sessionId;
            session.resume = { agentId: agent.id, protocol: 'acp', sessionId };
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
        }
        const ownId = sessionId;
        if (ownId) {
            host.routes.set(ownId, route);
        }
        // Detach this chat's route without touching the process: another chat may
        // still be using it.
        const forgetRoute = (): void => {
            if (ownId) {
                host.routes.delete(ownId);
            }
            const pending = host.opening.indexOf(route);
            if (pending >= 0) {
                host.opening.splice(pending, 1);
            }
        };
        touch(session);
        const live = client;
        return {
            get alive() {
                return connection.alive;
            },
            prompt: async text => {
                const result = await live.prompt(sessionId!, text);
                lastUsage = acpUsage(result.usage);
            },
            // ACP answers `session/prompt` with a `cancelled` stop reason after
            // its `session/cancel` notification, so no local side effect is needed.
            interrupt: () => {
                // Set by `session/new` or `session/load` before this link exists.
                if (sessionId) {
                    live.cancel(sessionId);
                }
            },
            dispose: () => {
                // A lane of the process, not the process itself: releasing a chat
                // releases its claim, and the last claim kills the child.
                forgetRoute();
                releaseAcpHost(host, session);
            },
            capabilities: { shell: false, midTurn: 'queue', interrupt: true },
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
        const resume = session.resume;
        const connection = new PiRpcConnection(agent.command, piArgs(agent.args, session.persist, resume), workingDirectory, {
            event: record => {
                appendPiEvent(session, record);
                if (record.type === 'agent_settled') {
                    drainQueue(session);
                    touch(session);
                }
            },
            uiRequest: record => answerPiUiRequest(session, connection, record),
            exit: reason => handleExit(session, reason)
        });
        const handshake = await connection.start().catch(error => {
            connection.dispose();
            throw error;
        });

        // Pi reports the session it opened (or resumed). That id/file is what a
        // later resume must pass to `--session`; without it the conversation
        // could never be continued.
        const nativeId = readString(handshake?.sessionId);
        const sessionFile = readString(handshake?.sessionFile);
        if (nativeId) {
            session.resume = {
                agentId: agent.id,
                protocol: 'pi-rpc',
                sessionId: nativeId,
                ...(sessionFile ? { sessionFile } : {})
            };
            touch(session);
        }
        if (resume) {
            // The agent keeps its own history; read it back so the panel shows
            // the conversation it is continuing instead of an empty transcript.
            const restored = await connection
                .request<{ messages?: readonly Record<string, unknown>[] }>({ type: 'get_messages' })
                .then(result => piTranscript(result?.messages ?? []))
                .catch(() => []);
            if (restored.length > 0) {
                // The agent's own history, replayed as the same vocabulary a live
                // turn emits, so a resumed panel renders it identically.
                for (const entry of restored.slice(-MAX_EVENTS)) {
                    pushEntry(session, entry);
                    session.streamingText = false;
                }
                touch(session);
            }
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
            interrupt: () => connection.abort(),
            dispose: () => connection.dispose(),
            capabilities: { shell: true, midTurn: 'steer', interrupt: true },
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
                steer: async text => {
                    await connection.prompt(text, 'steer');
                },
                newSession: async () => {
                    const result = await connection.request<{ cancelled?: unknown }>({ type: 'new_session' });
                    if (result?.cancelled === true) {
                        throw new Error('The agent cancelled the new session.');
                    }
                    // `/new` replaces the agent-side conversation: re-read the
                    // session Pi created so a later resume opens the new one, not
                    // the one that was just discarded.
                    const state = await connection.request<PiState>({ type: 'get_state' }).catch(() => undefined);
                    const nativeId = readString(state?.sessionId);
                    if (nativeId) {
                        const sessionFile = readString(state?.sessionFile);
                        session.resume = {
                            agentId: agent.id,
                            protocol: 'pi-rpc',
                            sessionId: nativeId,
                            ...(sessionFile ? { sessionFile } : {})
                        };
                    }
                },
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

    /**
     * Delivers a message that arrived while the agent was working.
     *
     * With a steering channel the agent takes it mid-turn, exactly as typing in
     * its own interactive mode does. Without one the message waits in a
     * client-side queue that is drained when the current turn ends; a steering
     * request the agent refuses falls back to that queue rather than vanishing.
     */
    async function midTurnMessage(session: LiveSession, text: string): Promise<void> {
        pushEntry(session, { role: 'user', text });
        const introspect = session.link?.introspect;
        const midTurn = session.link?.capabilities.midTurn ?? 'queue';
        if (midTurn === 'steer' && introspect?.steer) {
            try {
                await introspect.steer(text);
                pushEntry(session, { role: 'system', text: 'Steering message queued for the current turn.' });
                return;
            } catch (error) {
                pushEntry(session, {
                    role: 'system',
                    text: `Steering was refused (${describeError(error)}); queued for the end of the turn.`
                });
            }
        }
        session.queue.push(text);
        pushEntry(session, { role: 'system', text: 'Queued: sent when the current turn ends.' });
        touch(session);
    }

    /** Starts the next queued message once the session is idle again. */
    function drainQueue(session: LiveSession): void {
        if (session.status === 'running' || session.status === 'starting' || session.queue.length === 0) {
            return;
        }
        const next = session.queue.shift();
        if (next === undefined) {
            return;
        }
        session.status = 'running';
        session.error = undefined;
        void runTurn(session, next).catch(() => undefined);
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
        touch(session);
    }

    /** Runs an operation that can fail, surfacing the error in the transcript. */
    async function guard(session: LiveSession, operation: () => Promise<void>): Promise<void> {
        try {
            await operation();
            touch(session);
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

    // ACP replays the whole conversation through `session/update` while
    // `session/load` is outstanding. Live user chunks are skipped because the
    // panel already pushed the prompt it sent.
    if (kind === 'user_message_chunk' && session.replaying) {
        const text = contentText(update.content);
        if (text) {
            // A replayed user turn starts a new transcript entry; without this
            // the replayed assistant messages would merge into one bubble.
            session.streamingText = false;
            pushEntry(session, { role: 'user', text });
        }
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
 * Rewrites AG-UI events into the same transcript entries the other protocols
 * produce.
 *
 * Only what a reader needs is surfaced: streamed text, reasoning, tool activity
 * and the end of the run. `STATE_SNAPSHOT`, `MESSAGES_SNAPSHOT`, `STEP_*` and
 * raw payloads are the server's own bookkeeping and stay out of the transcript;
 * so do the incremental tool-call argument fragments, which are only meaningful
 * once the call ends.
 */
function appendAgUiEvent(session: LiveSession, event: AgUiEvent): void {
    switch (event.type) {
        case 'RUN_STARTED':
            session.status = 'running';
            return;
        case 'RUN_FINISHED':
            session.status = 'idle';
            session.streamingText = false;
            return;
        case 'RUN_ERROR': {
            const message = readString(event.message) ?? 'The AG-UI run failed.';
            session.status = 'error';
            session.error = message;
            session.streamingText = false;
            pushEntry(session, { role: 'system', text: message });
            return;
        }
        case 'TEXT_MESSAGE_START':
            // A new message starts a new bubble; without this the next agent
            // message would be appended to the previous one.
            session.streamingText = false;
            return;
        case 'TEXT_MESSAGE_CONTENT': {
            const delta = readString(event.delta);
            if (delta) {
                appendAgentText(session, delta);
            }
            return;
        }
        case 'TEXT_MESSAGE_END':
            session.streamingText = false;
            return;
        case 'THINKING_TEXT_MESSAGE_CONTENT':
        case 'REASONING_MESSAGE_CONTENT': {
            const delta = readString(event.delta);
            if (delta) {
                pushEntry(session, { role: 'system', text: `thought: ${delta}` });
            }
            return;
        }
        case 'TOOL_CALL_START': {
            const name = readString(event.toolCallName) ?? 'tool';
            pushEntry(session, { role: 'tool', text: `tool: ${name}` });
            return;
        }
        case 'TOOL_CALL_RESULT': {
            const content = readString(event.content);
            if (content) {
                pushEntry(session, { role: 'tool', text: `tool: ${truncate(content, 300)}` });
            }
            return;
        }
        default:
            // `CUSTOM`, `STATE_SNAPSHOT`/`STATE_DELTA`, `MESSAGES_SNAPSHOT`, `RAW`
            // and future event types. Dropped on purpose: a transcript entry is
            // text, and none of these carry text the reader needs. `CUSTOM` is
            // where generative-UI payloads arrive, so this is the one place a
            // GenUI renderer would hook in — no protocol work is needed for it.
            return;
    }
}

/**
 * The message history this run carries.
 *
 * A turn is one POST, and AG-UI expects the client to send the conversation it
 * wants the agent to see: the protocol has no duplex channel the server maintains
 * per message. The transcript is therefore mapped back onto user/assistant
 * messages — tool and system entries describe the panel, not the conversation —
 * and the prompt being sent replaces the last user entry, because the panel
 * stores what the user typed while the agent receives the version with inlined
 * `@path` attachments.
 */
function messageHistory(session: LiveSession, prompt: string): readonly AgUiMessage[] {
    // Rebuilt from the event log rather than a transcript: the vocabulary is the
    // record, so a resumed conversation and a live one rebuild identically.
    const history: AgUiMessage[] = [];
    const openMessages = new Map<string, { role: 'assistant'; content: string }>();
    for (const event of session.events) {
        if (event.type === 'CUSTOM' && event.name === 'icebox/user-message') {
            const text = typeof event.value.text === 'string' ? event.value.text : undefined;
            if (text) {
                history.push({ id: agUiId('user'), role: 'user', content: text });
            }
        } else if (event.type === 'TEXT_MESSAGE_START') {
            openMessages.set(event.messageId, { role: 'assistant', content: '' });
        } else if (event.type === 'TEXT_MESSAGE_CONTENT') {
            const message = openMessages.get(event.messageId);
            if (message) {
                message.content += event.delta;
            } else {
                openMessages.set(event.messageId, { role: 'assistant', content: event.delta });
            }
        } else if (event.type === 'TEXT_MESSAGE_END') {
            const message = openMessages.get(event.messageId);
            if (message && message.content) {
                history.push({ id: event.messageId, role: message.role, content: message.content });
            }
        }
    }
    const last = history[history.length - 1];
    if (last && last.role === 'user') {
        history[history.length - 1] = { ...last, content: prompt };
    } else {
        history.push({ id: agUiId('user'), role: 'user', content: prompt });
    }
    return history;
}

function truncate(text: string, limit: number): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
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
        // An abort the user asked for already has its own transcript line, added
        // when the interrupt was accepted; only an agent-initiated abort is news.
        if (record.aborted === true && !session.interrupted) {
            pushEntry(session, { role: 'system', text: 'Turn aborted.' });
        }
        session.interrupted = false;
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
    const open = session.streamingText ? session.messageId : undefined;
    if (open) {
        const messageId = open;
        recordEvent(session, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text });
        return;
    }
    const messageId = `m${session.eventsBase + session.events.length + 1}`;
    recordEvent(session, { type: 'TEXT_MESSAGE_START', messageId });
    recordEvent(session, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text });
    session.messageId = messageId;
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

/**
 * Pending `waitForChange` calls, one resolver per waiting panel.
 *
 * Module scope, not per-`activate`: a recorded event has to wake a waiter as much
 * as a status change does, and events are appended by helpers that live out here.
 */
const waiters = new Map<string, Set<(revision: number) => void>>();

const wakeWaiters = (session: LiveSession): void => {
    const waiting = waiters.get(session.sessionId);
    if (!waiting) {
        return;
    }
    // Cleared before resolving: a resolver that re-waits must not be called twice
    // by the same change.
    waiters.delete(session.sessionId);
    for (const resolve of waiting) {
        resolve(session.revision);
    }
};

function resetEvents(session: LiveSession): void {
    session.eventsBase += session.events.length;
    session.events = [];
    session.messageId = undefined;
    session.streamingText = false;
}

function recordEvent(session: LiveSession, event: RuntimeEvent): void {
    session.events.push(event);
    // Text deltas change the transcript without a status change, so the bump
    // belongs here: a panel waiting for a change has to see streamed text as it
    // arrives, not when the turn happens to end.
    session.revision += 1;
    wakeWaiters(session);
    if (session.events.length > MAX_EVENTS) {
        const dropped = session.events.length - MAX_EVENTS;
        session.events.splice(0, dropped);
        // Trimmed events stay addressable by cursor: a consumer holding position
        // `n` must still be able to ask for everything after it.
        session.eventsBase += dropped;
    }
}

/**
 * Transcript entry → AG-UI event.
 *
 * Every protocol mapping funnels through here, which is what makes one
 * vocabulary describe all of them: text streams as `TEXT_MESSAGE_*`, tool
 * activity as `TOOL_CALL_RESULT`, and the app-specific residue (who spoke, what
 * the runtime noted) as `CUSTOM` events instead of invented event types.
 */
function pushEntry(session: LiveSession, entry: ChatEntry): void {
    const nextId = (): string => `m${session.eventsBase + session.events.length + 1}`;
    switch (entry.role) {
        case 'agent': {
            const messageId = nextId();
            recordEvent(session, { type: 'TEXT_MESSAGE_START', messageId });
            recordEvent(session, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: entry.text });
            recordEvent(session, { type: 'TEXT_MESSAGE_END', messageId });
            session.messageId = undefined;
            return;
        }
        case 'tool': {
            recordEvent(session, { type: 'TOOL_CALL_RESULT', toolCallId: nextId(), content: entry.text });
            return;
        }
        case 'user': {
            recordEvent(session, { type: 'CUSTOM', name: 'icebox/user-message', value: { text: entry.text } });
            if (!session.title) {
                const line = entry.text.trim().split('\n')[0]?.trim();
                session.title = line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : undefined;
            }
            return;
        }
        case 'system':
            recordEvent(session, { type: 'CUSTOM', name: 'icebox/system', value: { text: entry.text } });
            return;
    }
}

/**
 * The agents this install can chat with.
 *
 * Sources, in order: `ICEBOX_AGENTS` (also accepted under its old name
 * `ICEBOX_ACP_AGENTS`), which is an explicit configuration and therefore replaces
 * everything; otherwise every enabled plugin's `contributes.agents`. A declaration
 * is untrusted data the host has already validated, so a bad protocol or a missing
 * command never reaches here.
 *
 * Duplicate ids keep the first declaration in plugin-id order: two plugins
 * claiming one id is a configuration mistake, and listing it twice would make the
 * picker ambiguous. Which plugin owns an id is reported through
 * {@link AgentDescriptor.pluginId}, so the user can see where it came from.
 */
async function discoverAgents(catalogue: WorkspacePluginsService | undefined): Promise<AgentDescriptor[]> {
    const configured = readConfiguredAgents();
    if (configured) {
        // An explicit configuration is the user's decision: list every entry, so
        // a missing binary is reported instead of silently disappearing.
        return configured.map(candidate => toDescriptor(candidate));
    }
    if (!catalogue) {
        return [];
    }
    const plugins = await catalogue.list();
    const seen = new Set<string>();
    const descriptors: AgentDescriptor[] = [];
    for (const plugin of plugins) {
        if (!plugin.enabled) {
            continue;
        }
        for (const agent of plugin.agents) {
            if (seen.has(agent.id)) {
                continue;
            }
            seen.add(agent.id);
            descriptors.push(toDescriptor(agent, plugin.id));
        }
    }
    return descriptors;
}

function toDescriptor(candidate: AgentCandidate, pluginId?: string): AgentDescriptor {
    const agui = aguiEndpoint(candidate.agui);
    return {
        id: candidate.id,
        name: candidate.name,
        protocol: candidate.protocol,
        command: candidate.command ?? '',
        args: candidate.args ?? [],
        ...(agui ? { agui } : {}),
        ...(pluginId ? { pluginId } : {}),
        // "Available" means there is something to try: an AG-UI endpoint needs no
        // binary at all, and an agent that has one can be reached even when its CLI
        // is not installed (the endpoint may wrap another runtime).
        available: agui !== undefined || commandAvailable(candidate.command ?? '')
    };
}

/**
 * Whether a CLI resolves on `PATH`, memoised for a moment.
 *
 * `accessSync` walks every `PATH` entry, and the panel re-reads the agent list on
 * its poll so a plugin toggled in the manager shows up without reopening the tab.
 * A couple of seconds is enough for that, and short enough to notice an install.
 */
const commandAvailability = new Map<string, { available: boolean; checkedAt: number }>();

function commandAvailable(command: string): boolean {
    const cached = commandAvailability.get(command);
    const now = Date.now();
    if (cached && now - cached.checkedAt < AVAILABILITY_TTL_MS) {
        return cached.available;
    }
    const available = executableExists(command);
    commandAvailability.set(command, { available, checkedAt: now });
    return available;
}

/**
 * The AG-UI endpoint an agent is tried over.
 *
 * A declared endpoint wins. `ICEBOX_AGUI_URL` is the default for every agent that
 * does not declare one, which is how a single gateway in front of several CLIs is
 * wired without repeating its URL per agent; it is unset by default, so a plain
 * install talks to the agents' own protocols.
 */
function aguiEndpoint(declared: string | undefined): string | undefined {
    const own = declared?.trim();
    if (own) {
        return own;
    }
    const shared = process.env.ICEBOX_AGUI_URL?.trim();
    return shared ? shared : undefined;
}

/** True when the agent has something to start: an AG-UI endpoint or a binary. */
function agentCanStart(agent: AgentDescriptor): boolean {
    return agent.agui !== undefined || executableExists(agent.command);
}

function readConfiguredAgents(): AgentCandidate[] | undefined {
    const raw = process.env.ICEBOX_AGENTS ?? process.env.ICEBOX_ACP_AGENTS;
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
            const command = readString(record.command)?.trim() ?? '';
            const agui = readString(record.agui)?.trim();
            // An entry needs something to talk to: a binary, an AG-UI endpoint, or
            // both (endpoint first, binary as the fallback).
            const handle = command || agui;
            if (!handle) {
                continue;
            }
            const args = Array.isArray(record.args)
                ? record.args.filter((arg): arg is string => typeof arg === 'string')
                : [];
            agents.push({
                id: readString(record.id) ?? handle,
                name: readString(record.name) ?? handle,
                protocol: isProtocol(record.protocol) ? record.protocol : 'acp',
                command,
                args,
                ...(agui ? { agui } : {})
            });
        }
        return agents.length > 0 ? agents : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A configured protocol is validated by the API's own predicate, so a new
 * protocol is known here as soon as it exists in `plugin-api`.
 */
const isProtocol = isAgentProtocol;

function readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** True when the agent advertised that it can reload an earlier session. */
function isLoadSessionSupported(capabilities: unknown): boolean {
    if (typeof capabilities !== 'object' || capabilities === null) {
        return false;
    }
    return (capabilities as Record<string, unknown>).loadSession === true;
}

/**
 * Pi's command line for this session.
 *
 * A project chat must persist so a later resume can find it, and a resumed chat
 * passes the agent's own handle to `--session` — the same flag Pi's interactive
 * resume uses. Plain chat tabs keep `--no-session`, as before.
 */
function piArgs(baseArgs: readonly string[], persist: boolean, resume: AgentSessionHandle | undefined): string[] {
    if (resume) {
        const args = baseArgs.filter(arg => arg !== '--no-session');
        return [...args, '--session', resume.sessionFile ?? resume.sessionId];
    }
    return persist ? baseArgs.filter(arg => arg !== '--no-session') : [...baseArgs];
}

/** Maps Pi's persisted messages back onto the panel transcript. */
function piTranscript(messages: readonly Record<string, unknown>[]): ChatEntry[] {
    const entries: ChatEntry[] = [];
    for (const message of messages) {
        const role = readString(message.role);
        if (role === 'user') {
            const text = piContentText(message.content);
            if (text) {
                entries.push({ role: 'user', text });
            }
            continue;
        }
        if (role === 'assistant') {
            for (const block of piContentBlocks(message.content)) {
                const kind = readString(block.type);
                if (kind === 'text') {
                    const text = readString(block.text);
                    if (text) {
                        entries.push({ role: 'agent', text });
                    }
                } else if (kind === 'toolCall') {
                    entries.push({ role: 'tool', text: `tool: ${readString(block.name) ?? 'tool'}` });
                }
            }
            continue;
        }
        if (role === 'toolResult') {
            const name = readString(message.toolName) ?? 'tool';
            const text = piContentText(message.content);
            entries.push({ role: 'tool', text: text ? `tool: ${name}\n${text}` : `tool: ${name}` });
            continue;
        }
        if (role === 'bashExecution') {
            const command = readString(message.command);
            const output = readString(message.output) ?? '';
            if (command) {
                entries.push({ role: 'tool', text: `$ ${command}${output ? `\n${output.trimEnd()}` : ''}` });
            }
        }
    }
    return entries;
}

function piContentBlocks(content: unknown): Record<string, unknown>[] {
    return Array.isArray(content)
        ? content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
        : [];
}

function piContentText(content: unknown): string | undefined {
    if (typeof content === 'string') {
        return content;
    }
    const texts = piContentBlocks(content)
        .map(block => readString(block.text))
        .filter((text): text is string => Boolean(text));
    return texts.length > 0 ? texts.join('\n') : undefined;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
