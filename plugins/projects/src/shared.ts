/** Data shared by the Projects panel's renderer and backend halves. */

import type {
    AgentDescriptor,
    AgentSessionHandle,
    AgentSessionSummary,
    AgentStatus
} from '@icebox/plugin-api';

/** One stored agent conversation that belongs to a project. */
export interface ProjectSessionRecord {
    /**
     * The logical agent session id, chosen by this plugin when the chat opens.
     *
     * It stays the same when the conversation is resumed, so a session is
     * addressable even though the host picks a new panel instance id for every
     * tab.
     */
    readonly id: string;
    readonly agentId: string;
    /** First line of the first prompt, or a placeholder until one arrives. */
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly archived: boolean;
    /** The agent's own handle; absent until the agent has started once. */
    readonly resume?: AgentSessionHandle;
    /** Last observed liveness while the session ran. */
    readonly status?: AgentStatus;
}

/** One project folder the user added. */
export interface ProjectRecord {
    readonly id: string;
    readonly name: string;
    /** Absolute folder the project's agent sessions run in. */
    readonly path: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly archived: boolean;
    readonly sessions: readonly ProjectSessionRecord[];
}

export interface ProjectsSnapshot {
    readonly projects: readonly ProjectRecord[];
}

/** The fields the panel supplies when it starts a new project session. */
export interface NewProjectSession {
    readonly id: string;
    readonly agentId: string;
    readonly title?: string;
}

/**
 * Durable project/session storage, provided by the Projects backend as
 * `projects.store` and consumed by its own renderer half over the RPC bridge.
 *
 * Everything is JSON-serializable because every call crosses that bridge.
 */
export interface ProjectsService {
    /** Current data, without contacting any live agent session. */
    snapshot(): Promise<ProjectsSnapshot>;
    /**
     * Updates stored sessions from their live summaries and returns the result.
     *
     * This is what keeps titles and status current without a push channel; the
     * backend also does the same work when agent-chat emits a change event.
     */
    refresh(): Promise<ProjectsSnapshot>;
    /** Adds a folder; an already stored folder is returned un-archived. */
    addProject(path: string, name?: string): Promise<ProjectRecord>;
    setProjectArchived(projectId: string, archived: boolean): Promise<ProjectRecord>;
    /** Removes the project and its stored sessions; live agents are released. */
    removeProject(projectId: string): Promise<void>;
    /** Records a chat the panel just opened. */
    addSession(projectId: string, session: NewProjectSession): Promise<ProjectSessionRecord>;
    setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
    /** Removes a stored session; a live agent under that id is released. */
    removeSession(sessionId: string): Promise<void>;
}

/**
 * The subset of `agent.sessions` this plugin consumes.
 *
 * Projects must not import agent-chat's implementation (plugins only talk
 * through services), so the shape is restated here. Every member is part of the
 * public contract in `@icebox/plugin-api`.
 */
export interface AgentSessionsView {
    listAgents(): Promise<AgentDescriptor[]>;
    summary(sessionId: string): Promise<AgentSessionSummary>;
    listLiveSessions(): Promise<AgentSessionSummary[]>;
    release(sessionId: string): Promise<void>;
}
