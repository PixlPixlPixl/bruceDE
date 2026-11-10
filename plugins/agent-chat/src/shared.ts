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
}
