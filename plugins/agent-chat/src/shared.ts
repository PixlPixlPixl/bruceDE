/** Wire types shared by the agent-chat plugin's renderer and backend halves. */

/**
 * Wire protocol the backend speaks to an agent CLI.
 *
 * `acp` is the Agent Client Protocol (JSON-RPC over stdio), spoken by Gemini CLI,
 * Claude Code and others. `pi-rpc` is Pi's own JSONL command/event protocol
 * (`pi --mode rpc`); Pi does not implement ACP.
 */
export type AgentProtocol = 'acp' | 'pi-rpc';

/** One agent executable the backend can control. */
export interface AgentDescriptor {
    readonly id: string;
    readonly name: string;
    readonly protocol: AgentProtocol;
    readonly command: string;
    readonly args: readonly string[];
    /** False when the executable is not on `PATH`; shown as unavailable. */
    readonly available: boolean;
}

export type AgentStatus = 'idle' | 'starting' | 'running' | 'error';

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
}

/** Snapshot of one agent conversation. */
export interface AgentState {
    readonly agentId: string;
    readonly status: AgentStatus;
    readonly entries: readonly ChatEntry[];
    readonly error?: string;
    /** Working directory the agent was started in; the `@` completion starts here. */
    readonly cwd?: string;
    readonly capabilities?: AgentCapabilities;
    readonly model?: AgentModelState;
    readonly usage?: AgentUsageInfo;
    readonly commands?: readonly AgentCommand[];
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
     */
    openSession(sessionId: string, agentId: string): Promise<AgentState>;
    /** Transcript and status of a session; empty and idle when it is unknown. */
    state(sessionId: string): Promise<AgentState>;
    /** Appends the prompt and starts the turn; resolves once it is running. */
    send(sessionId: string, text: string): Promise<AgentState>;
    /** Cancels the in-flight turn, if any. */
    cancel(sessionId: string): Promise<AgentState>;
    /** Clears the transcript and keeps the agent binding. */
    reset(sessionId: string): Promise<AgentState>;
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
