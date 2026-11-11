/** Wire types shared by the agent-chat plugin's renderer and backend halves. */

import type {
    AgentDescriptor,
    AgentSessionHandle,
    AgentSessionOptions,
    AgentSessionSummary,
    AgentStatus
} from '@icebox/plugin-api';

// The agent wire contract is public: other workspace plugins (Projects) consume
// the same descriptors, handles and summaries. Re-exporting keeps every existing
// import path inside this plugin working.
export type {
    AgentDescriptor,
    AgentProtocol,
    AgentSessionHandle,
    AgentSessionOptions,
    AgentSessionSummary,
    AgentStatus
} from '@icebox/plugin-api';

/** One transcript entry. `tool` entries are tool calls and shell runs. */
export interface ChatEntry {
    readonly role: 'user' | 'agent' | 'tool' | 'system';
    readonly text: string;
}

/**
 * One model the connected agent can switch to.
 *
 * `key` is the selection handle this plugin sends back: Pi addresses models by
 * provider *and* id (the same id can exist in several providers), so the key
 * carries both and the panel never has to know the protocol's shape.
 */
export interface AgentModelInfo {
    readonly key: string;
    readonly name: string;
    readonly provider?: string;
    /** Raw model id the agent's `set_model` expects. */
    readonly modelId: string;
    readonly contextWindow?: number;
}

/** Model/thinking selection of a live session, as the agent reports it. */
export interface AgentModelState {
    readonly current?: AgentModelInfo;
    readonly thinking?: string;
    /** Levels the *current* model supports; empty when it has no reasoning. */
    readonly thinkingLevels?: readonly string[];
    /**
     * How many models the agent offers. The list itself is fetched on demand
     * through {@link AgentSessionsService.searchModels}: Pi reports thousands of
     * models, which must not travel with every poll.
     */
    readonly modelCount?: number;
}

/**
 * Token accounting of a live session.
 *
 * `cacheHitPercent` is the share of input-side tokens served from the provider's
 * prompt cache — `cacheRead / (input + cacheRead)` over the whole session, which
 * is how a cache hit rate is normally read. It is absent until the agent has
 * reported usage at least once.
 */
export interface AgentUsageInfo {
    readonly contextTokens?: number | null;
    readonly contextWindow?: number;
    readonly contextPercent?: number | null;
    readonly cacheHitPercent?: number;
    readonly totalTokens?: number;
    readonly cost?: number;
}

/** One command the agent exposes for `/name`. */
export interface AgentCommand {
    readonly name: string;
    readonly description?: string;
    /** `extension`, `prompt`, `skill` (Pi) or `acp` (agent-provided). */
    readonly source?: string;
}

/** What the connected agent can do beyond plain prompting. */
export interface AgentCapabilities {
    /** The agent can run a shell command on its own (`!command` in the composer). */
    readonly shell: boolean;
    /**
     * How a message sent while the agent is working is delivered.
     *
     * `steer` hands it to the agent mid-turn, which is what Pi's own interactive
     * mode does; `queue` keeps it client-side and sends it when the current turn
     * ends, because the protocol has no steering channel (ACP).
     */
    readonly midTurn: 'steer' | 'queue';
}

/** Snapshot of one agent conversation. */
export interface AgentState {
    readonly agentId: string;
    readonly status: AgentStatus;
    /**
     * Protocol this session actually speaks, once it has started.
     *
     * Absent before the first turn. It differs from the agent's declared
     * `protocol` when an AG-UI endpoint answered, because AG-UI is tried first
     * and the agent's native protocol is only the fallback.
     */
    readonly protocol?: AgentProtocol;
    /** Why the configured AG-UI endpoint was not used, when it was not. */
    readonly aguiUnavailable?: string;
    readonly entries: readonly ChatEntry[];
    readonly error?: string;
    /** Working directory the agent was started in; the `@` completion starts here. */
    readonly cwd?: string;
    readonly capabilities?: AgentCapabilities;
    readonly model?: AgentModelState;
    readonly usage?: AgentUsageInfo;
    readonly commands?: readonly AgentCommand[];
    /**
     * The agent's own handle for this conversation.
     *
     * Present once the agent has started; a workspace plugin stores it verbatim
     * and passes it back as {@link AgentSessionOptions.resume} to continue the
     * same agent-side session instead of starting a new one.
     */
    readonly resume?: AgentSessionHandle;
}

/**
 * One chat session per panel instance.
 *
 * A session id **is** a panel instance id: two chat tabs talk to independent
 * sessions, so opening a second chat never disturbs the first. The backend keeps
 * the child process, transcript and status per session id.
 */
export interface AgentSessionsService {
    /** Every agent this build supports, installed or not. */
    listAgents(): AgentDescriptor[] | Promise<AgentDescriptor[]>;
    /**
     * Binds a session to an agent (creating the session on first use) and returns
     * its current state. Re-binding an existing session switches its agent and
     * clears the transcript.
     *
     * `options.cwd` makes the agent run in that folder instead of the workspace
     * directory. `options.resume` continues an earlier agent-side conversation
     * through the agent's native mechanism (`--session` for Pi, `session/load` for
     * ACP) and rebuilds the transcript from it.
     */
    openSession(sessionId: string, agentId: string, options?: AgentSessionOptions): Promise<AgentState>;
    /** Transcript and status of a session; empty and idle when it is unknown. */
    state(sessionId: string): Promise<AgentState>;
    /**
     * Cheap status/title/handle snapshot of a session.
     *
     * `live` is false for an unknown session, so a caller can tell "nothing is
     * running under this id" from "an agent is idle".
     */
    summary(sessionId: string): Promise<AgentSessionSummary>;
    /**
     * Every live session on this backend.
     *
     * A project list uses this to adopt a chat opened with a project's working
     * directory from elsewhere (the chat's own + button, for example), so every
     * session that ran in a project is stored and resumable.
     */
    listLiveSessions(): Promise<AgentSessionSummary[]>;
    /**
     * Appends the prompt and starts the turn; resolves once it is running.
     *
     * A message sent while a turn is in flight is not rejected: it is steered
     * into the running turn or queued for its end, following
     * {@link AgentCapabilities.midTurn}.
     */
    send(sessionId: string, text: string): Promise<AgentState>;
    /** Releases the child process of a session whose panel is gone. */
    release(sessionId: string): Promise<void>;

    /** Models of a session matching `query`, capped at `limit`. */
    searchModels(sessionId: string, query: string, limit?: number): Promise<AgentModelInfo[]>;
    /** Switches the session to one of the models {@link searchModels} returned. */
    selectModel(sessionId: string, modelKey: string): Promise<AgentState>;
    /** Sets the reasoning level to one of {@link AgentModelState.thinkingLevels}. */
    selectThinking(sessionId: string, level: string): Promise<AgentState>;
    /**
     * Runs one shell command through the agent and records its output in the
     * transcript. Only meaningful when {@link AgentCapabilities.shell} is true.
     */
    runShell(sessionId: string, command: string): Promise<AgentState>;
}
