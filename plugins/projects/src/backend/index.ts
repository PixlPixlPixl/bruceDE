import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
    AgentSessionChange,
    AgentSessionSummary,
    AgentStatus,
    BackendPluginAPI
} from '@icebox/plugin-api';
import { WORKSPACE_EVENT_IDS, WORKSPACE_SERVICE_IDS } from '@icebox/plugin-api';
import type {
    AgentSessionsView,
    ProjectRecord,
    ProjectsService,
    ProjectSessionRecord
} from '../shared.js';

/** Service id this plugin provides; the renderer half resolves it remotely. */
const PROJECTS_SERVICE_ID = 'projects.store';

/** Folder under the user's home where Icebox keeps durable plugin data. */
const USER_DATA_DIR_NAME = '.icebox';

const STATUSES: readonly AgentStatus[] = ['idle', 'starting', 'running', 'error'];

interface PersistedShape {
    readonly version: 1;
    readonly projects: readonly ProjectRecord[];
}

/**
 * Backend half of Projects: durable, per-folder agent session storage.
 *
 * The renderer half owns the list UI; this module owns the JSON file
 * (`~/.icebox/projects.json` or `$ICEBOX_STATE_DIR/projects.json`), validates
 * what it reads back, and keeps stored titles/status in step with agent-chat.
 * It talks to agent-chat only through the public `agent.sessions` service and
 * its `agent/session-changed` event — never by importing the plugin.
 */
export function activate(api: BackendPluginAPI): void {
    const stateFile = projectsFile();
    const projects = new Map<string, ProjectRecord>();
    /** Summaries that arrived before the panel recorded the session. */
    const pending = new Map<string, AgentSessionSummary>();
    let loaded = false;
    /** Mutations are serialized: each reads the map, rewrites it, then persists. */
    let queue: Promise<unknown> = Promise.resolve();
    let writes: Promise<void> = Promise.resolve();

    const now = (): string => new Date().toISOString();

    const sessionsView = (): AgentSessionsView | undefined =>
        api.services.has(WORKSPACE_SERVICE_IDS.agentSessions)
            ? api.services.get<AgentSessionsView>(WORKSPACE_SERVICE_IDS.agentSessions)
            : undefined;

    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = queue.then(operation, operation);
        queue = next.then(() => undefined, () => undefined);
        return next;
    };

    const persist = (): Promise<void> => {
        const content = `${JSON.stringify({ version: 1, projects: [...projects.values()] } satisfies PersistedShape, null, 2)}\n`;
        const writer = async (): Promise<void> => {
            await fs.mkdir(path.dirname(stateFile), { recursive: true });
            const temporary = `${stateFile}.${process.pid}.tmp`;
            await fs.writeFile(temporary, content, 'utf8');
            await fs.rename(temporary, stateFile);
        };
        writes = writes.then(writer, writer);
        return writes;
    };

    const ensureLoaded = async (): Promise<void> => {
        if (loaded) {
            return;
        }
        loaded = true;
        let raw: unknown;
        try {
            raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        } catch {
            // A fresh install has no file; a corrupt one is reported and ignored
            // rather than crashing the plugin, and the next write replaces it.
            return;
        }
        for (const project of parseProjects(raw)) {
            projects.set(project.id, project);
        }
    };

    const findSession = (sessionId: string): { project: ProjectRecord; session: ProjectSessionRecord } | undefined => {
        for (const project of projects.values()) {
            const session = project.sessions.find(candidate => candidate.id === sessionId);
            if (session) {
                return { project, session };
            }
        }
        return undefined;
    };

    /** Writes the project back with the given session list. */
    const replaceSession = (
        project: ProjectRecord,
        sessions: readonly ProjectSessionRecord[],
        updatedAt: string
    ): ProjectRecord => {
        const next: ProjectRecord = { ...project, sessions, updatedAt };
        projects.set(next.id, next);
        return next;
    };

    /**
     * Applies a live summary to a stored session.
     *
     * Only fields the agent actually reports are overwritten, so a transient
     * poll without a title cannot erase the one captured earlier.
     */
    const applySummary = (
        project: ProjectRecord,
        session: ProjectSessionRecord,
        summary: AgentSessionSummary
    ): boolean => {
        const title = summary.title?.trim() || session.title;
        const status = summary.status;
        const resume = summary.resume ?? session.resume;
        const updatedAt = summary.updatedAt ?? session.updatedAt;
        if (
            title === session.title
            && status === session.status
            && sameHandle(resume, session.resume)
            && updatedAt === session.updatedAt
        ) {
            return false;
        }
        const next: ProjectSessionRecord = {
            ...session,
            title,
            status,
            updatedAt,
            ...(resume ? { resume } : {})
        };
        replaceSession(project, project.sessions.map(candidate => (candidate.id === session.id ? next : candidate)), updatedAt);
        return true;
    };

    /**
     * Records a live session that ran in a project folder but was opened
     * elsewhere (the chat's own + button, or a restored tab).
     *
     * Without this such a chat would never appear in the project's list, even
     * though its working directory is the project.
     */
    const adopt = (summary: AgentSessionSummary): boolean => {
        const cwd = summary.cwd;
        if (!summary.live || !summary.agentId || !cwd || findSession(summary.sessionId)) {
            return false;
        }
        const owner = [...projects.values()].find(project =>
            !project.archived && project.path === path.resolve(cwd)
        );
        if (!owner) {
            return false;
        }
        const timestamp = summary.updatedAt ?? now();
        const record: ProjectSessionRecord = {
            id: summary.sessionId,
            agentId: summary.agentId,
            title: summary.title?.trim() || defaultTitle(summary.agentId),
            createdAt: timestamp,
            updatedAt: timestamp,
            archived: false,
            status: summary.status,
            resume: summary.resume
        };
        replaceSession(owner, [...owner.sessions, record], timestamp);
        return true;
    };

    /** Reacts to agent-chat's change event, before or after the panel recorded it. */
    const onAgentChanged = async (sessionId: string): Promise<void> => {
        await ensureLoaded();
        const view = sessionsView();
        if (!view) {
            return;
        }
        const summary = await view.summary(sessionId).catch(() => undefined);
        if (!summary || !summary.live) {
            return;
        }
        const found = findSession(sessionId);
        if (!found) {
            // The chat starts before `addSession` can return; keep the summary
            // until the panel's call arrives. A session that runs inside a stored
            // project folder is adopted right away instead.
            if (!adopt(summary)) {
                pending.set(sessionId, summary);
            } else {
                await persist();
            }
            return;
        }
        if (applySummary(found.project, found.session, summary)) {
            await persist();
        }
    };

    const service: ProjectsService = {
        snapshot: async () => {
            await ensureLoaded();
            return { projects: [...projects.values()] };
        },

        refresh: async () => serial(async () => {
            await ensureLoaded();
            const view = sessionsView();
            if (!view) {
                return { projects: [...projects.values()] };
            }
            let changed = false;
            // Re-look every session up after each update: applying a summary
            // replaces the project object, so a loop over the old array would
            // drop the previous change.
            const sessionIds = [...projects.values()].flatMap(project => project.sessions.map(session => session.id));
            for (const sessionId of sessionIds) {
                const found = findSession(sessionId);
                if (!found || found.session.archived) {
                    continue;
                }
                const summary = await view.summary(sessionId).catch(() => undefined);
                if (summary?.live && applySummary(found.project, found.session, summary)) {
                    changed = true;
                }
            }
            // Adopt sessions that ran in a project folder but were opened
            // elsewhere (the chat's own + button, or a restored tab).
            const live = await view.listLiveSessions().catch(() => []);
            for (const summary of live) {
                if (adopt(summary)) {
                    changed = true;
                }
            }
            if (changed) {
                await persist();
            }
            return { projects: [...projects.values()] };
        }),

        addProject: async (projectPath, name) => serial(async () => {
            await ensureLoaded();
            const trimmed = projectPath.trim();
            if (!trimmed) {
                throw new Error('A project needs a folder path.');
            }
            const resolved = path.resolve(trimmed);
            const stats = await fs.stat(resolved).catch(() => undefined);
            if (!stats?.isDirectory()) {
                throw new Error(`"${resolved}" is not an existing folder.`);
            }
            // Symlinked folders are stored by their real path so adding the same
            // repository twice does not create two projects.
            const real = await fs.realpath(resolved).catch(() => resolved);
            const existing = [...projects.values()].find(project => project.path === real);
            if (existing) {
                if (existing.archived) {
                    const restored: ProjectRecord = { ...existing, archived: false, updatedAt: now() };
                    projects.set(restored.id, restored);
                    await persist();
                    return restored;
                }
                return existing;
            }
            const timestamp = now();
            const project: ProjectRecord = {
                id: randomUUID(),
                name: name?.trim() || path.basename(real) || real,
                path: real,
                createdAt: timestamp,
                updatedAt: timestamp,
                archived: false,
                sessions: []
            };
            projects.set(project.id, project);
            await persist();
            return project;
        }),

        setProjectArchived: async (projectId, archived) => serial(async () => {
            await ensureLoaded();
            const project = projects.get(projectId);
            if (!project) {
                throw new Error('Unknown project.');
            }
            const next: ProjectRecord = { ...project, archived, updatedAt: now() };
            projects.set(next.id, next);
            await persist();
            return next;
        }),

        removeProject: async projectId => serial(async () => {
            await ensureLoaded();
            const project = projects.get(projectId);
            if (!project) {
                return;
            }
            const view = sessionsView();
            if (view) {
                for (const session of project.sessions) {
                    await view.release(session.id).catch(() => undefined);
                }
            }
            projects.delete(projectId);
            await persist();
        }),

        addSession: async (projectId, session) => serial(async () => {
            await ensureLoaded();
            const project = projects.get(projectId);
            if (!project) {
                throw new Error('Unknown project.');
            }
            if (!session.id.trim() || !session.agentId.trim()) {
                throw new Error('A session needs an id and an agent.');
            }
            const existing = project.sessions.find(candidate => candidate.id === session.id);
            if (existing) {
                return existing;
            }
            const timestamp = now();
            const summary = pending.get(session.id);
            if (summary) {
                pending.delete(session.id);
            }
            const record: ProjectSessionRecord = {
                id: session.id,
                agentId: session.agentId,
                title: summary?.title?.trim() || session.title?.trim() || defaultTitle(session.agentId),
                createdAt: timestamp,
                updatedAt: summary?.updatedAt ?? timestamp,
                archived: false,
                ...(summary?.status ? { status: summary.status } : {}),
                ...(summary?.resume ? { resume: summary.resume } : {})
            };
            replaceSession(project, [...project.sessions, record], record.updatedAt);
            await persist();
            return record;
        }),

        setSessionArchived: async (sessionId, archived) => serial(async () => {
            await ensureLoaded();
            const found = findSession(sessionId);
            if (!found) {
                throw new Error('Unknown session.');
            }
            const next: ProjectSessionRecord = { ...found.session, archived, updatedAt: now() };
            replaceSession(
                found.project,
                found.project.sessions.map(candidate => (candidate.id === sessionId ? next : candidate)),
                next.updatedAt
            );
            await persist();
        }),

        removeSession: async sessionId => serial(async () => {
            await ensureLoaded();
            const found = findSession(sessionId);
            if (!found) {
                return;
            }
            const view = sessionsView();
            await view?.release(sessionId).catch(() => undefined);
            replaceSession(
                found.project,
                found.project.sessions.filter(candidate => candidate.id !== sessionId),
                now()
            );
            await persist();
        })
    };

    api.services.provide(PROJECTS_SERVICE_ID, service);

    // Agent-chat emits whenever a live session binds its native handle, starts
    // a turn, settles or is released; a project session stores that state without
    // the panel having to poll agent-chat itself.
    api.events.on<AgentSessionChange>(WORKSPACE_EVENT_IDS.agentSessionChanged, payload => {
        if (typeof payload?.sessionId === 'string') {
            void serial(() => onAgentChanged(payload.sessionId)).catch(error => {
                // eslint-disable-next-line no-console
                console.error('[projects] failed to update session state:', error);
            });
        }
    });
}

/** `$ICEBOX_STATE_DIR` wins, matching the host's own plugin state location. */
function projectsFile(): string {
    const override = process.env.ICEBOX_STATE_DIR?.trim();
    const base = override ? path.resolve(override) : path.join(os.homedir(), USER_DATA_DIR_NAME);
    return path.join(base, 'projects.json');
}

/** Placeholder title shown until the first prompt provides a real one. */
function defaultTitle(agentId: string): string {
    return `New session (${agentId})`;
}

/**
 * Reads persisted projects defensively.
 *
 * A hand-edited or older file must never break the plugin: malformed projects
 * and sessions are dropped, and every field is re-derived from the directory
 * listing rather than trusted.
 */
function parseProjects(raw: unknown): ProjectRecord[] {
    if (typeof raw !== 'object' || raw === null) {
        return [];
    }
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.projects)) {
        return [];
    }
    const projects: ProjectRecord[] = [];
    const ids = new Set<string>();
    for (const entry of record.projects) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const project = entry as Record<string, unknown>;
        const id = readString(project.id);
        const projectPath = readString(project.path);
        if (!id || !projectPath || ids.has(id)) {
            continue;
        }
        ids.add(id);
        const sessions: ProjectSessionRecord[] = [];
        if (Array.isArray(project.sessions)) {
            for (const candidate of project.sessions) {
                const session = parseSession(candidate);
                if (session) {
                    sessions.push(session);
                }
            }
        }
        projects.push({
            id,
            name: readString(project.name) || path.basename(projectPath) || projectPath,
            path: projectPath,
            createdAt: readString(project.createdAt) || new Date().toISOString(),
            updatedAt: readString(project.updatedAt) || new Date().toISOString(),
            archived: project.archived === true,
            sessions
        });
    }
    return projects;
}

function parseSession(raw: unknown): ProjectSessionRecord | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const record = raw as Record<string, unknown>;
    const id = readString(record.id);
    const agentId = readString(record.agentId);
    if (!id || !agentId) {
        return undefined;
    }
    const createdAt = readString(record.createdAt) || new Date().toISOString();
    const resume = readHandle(record.resume);
    return {
        id,
        agentId,
        title: readString(record.title) || defaultTitle(agentId),
        createdAt,
        updatedAt: readString(record.updatedAt) || createdAt,
        archived: record.archived === true,
        ...(resume ? { resume } : {}),
        ...(STATUSES.includes(record.status as AgentStatus) ? { status: record.status as AgentStatus } : {})
    };
}

function readHandle(value: unknown): ProjectSessionRecord['resume'] {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const agentId = readString(record.agentId);
    const sessionId = readString(record.sessionId);
    const protocol = record.protocol;
    if (!agentId || !sessionId || (protocol !== 'acp' && protocol !== 'pi-rpc')) {
        return undefined;
    }
    const sessionFile = readString(record.sessionFile);
    return { agentId, protocol, sessionId, ...(sessionFile ? { sessionFile } : {}) };
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Compares two agent handles by value, since every summary re-creates the object. */
function sameHandle(left: ProjectSessionRecord['resume'], right: ProjectSessionRecord['resume']): boolean {
    if (left === right) {
        return true;
    }
    if (!left || !right) {
        return false;
    }
    return left.agentId === right.agentId
        && left.protocol === right.protocol
        && left.sessionId === right.sessionId
        && left.sessionFile === right.sessionFile;
}
