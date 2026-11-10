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

/** One transcript entry. `tool` entries are ACP tool-call summaries. */
export interface ChatEntry {
    readonly role: 'user' | 'agent' | 'tool' | 'system';
    readonly text: string;
}

/** Snapshot of one agent conversation. */
export interface AgentState {
    readonly agentId: string;
    readonly status: AgentStatus;
    readonly entries: readonly ChatEntry[];
    readonly error?: string;
}

/**
 * Provided by the backend half under `agent.sessions`.
 *
 * The renderer polls {@link AgentState} because the host cannot push backend
 * events across the RPC boundary; only renderer → backend calls exist.
 */
export interface AgentSessionsService {
    listAgents(): AgentDescriptor[] | Promise<AgentDescriptor[]>;
    state(agentId: string): AgentState | Promise<AgentState>;
    /** Appends the prompt and starts the turn; resolves once it is running. */
    send(agentId: string, text: string): Promise<AgentState>;
    /** Cancels the in-flight turn, if any. */
    cancel(agentId: string): Promise<AgentState>;
    /** Clears the transcript and drops the session. */
    reset(agentId: string): Promise<AgentState>;
}
