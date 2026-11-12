/** Wire types shared by the agent-chat plugin's renderer and backend halves. */

import type {
    AgentCapabilities,
    AgentCommand,
    AgentDescriptor,
    AgentModelInfo,
    AgentModelState,
    AgentProtocol,
    AgentSessionHandle,
    AgentSessionOptions,
    AgentSessionSummary,
    AgentStatus,
    AgentUsageInfo,
    ChatEntry
} from '@icebox/plugin-api';

// The agent wire contract is public: other workspace plugins (Projects) consume
// the same descriptors, handles and summaries. Re-exporting keeps every existing
// import path inside this plugin working.
export type {
    AgentCapabilities,
    AgentCommand,
    AgentDescriptor,
    AgentModelInfo,
    AgentModelState,
    AgentProtocol,
    AgentSessionHandle,
    AgentSessionOptions,
    AgentSessionSummary,
    AgentStatus,
    AgentUsageInfo,
    ChatEntry
} from '@icebox/plugin-api';


// The remaining wire shapes are the runtime's own vocabulary: models, usage,
// commands and capabilities all travel through `agent.runtime` now, so they are
// re-exported from `plugin-api` rather than restated here. A local copy would
// silently diverge from the contract the orchestrator implements.
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
    /** Stops the turn in flight; the conversation and transcript survive it. */
    interrupt(sessionId: string): Promise<AgentState>;
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
