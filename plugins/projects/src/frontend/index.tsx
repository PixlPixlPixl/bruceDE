import type * as ReactNS from 'react';
import type {
    AgentChatLauncherService,
    AgentDescriptor,
    FrontendPluginAPI,
    PanelHostTools,
    WorkspaceDialogsService
} from '@icebox/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@icebox/plugin-api';
import type {
    AgentSessionsView,
    ProjectRecord,
    ProjectsService,
    ProjectsSnapshot,
    ProjectSessionRecord
} from '../shared.js';

const PANEL_PROJECTS = 'projects.list';
const COMMAND_OPEN = 'icebox.projects.open';
/** Backend status updates have no push channel; a small poll keeps the list live. */
const POLL_INTERVAL_MS = 2500;
/** Service id the plugin's own backend provides. */
const PROJECTS_SERVICE_ID = 'projects.store';

/**
 * Native renderer entrypoint for the project list.
 *
 * A project is a folder the user added. Its sessions are agent-chat panels the
 * backend started in that folder; this panel only stores the metadata (native
 * session handle included) and reopens them through the agent-chat launcher, so
 * the chat remains owned by the plugin that implements it.
 */
export function activate(api: FrontendPluginAPI): void {
    const projects = api.services.remote<ProjectsService>(PROJECTS_SERVICE_ID);
    const sessions = api.services.remote<AgentSessionsView>(WORKSPACE_SERVICE_IDS.agentSessions);

    api.panels.register({
        id: PANEL_PROJECTS,
        title: 'Projects',
        createWidget: (instanceId, host) => {
            const widget = host.createReactWidget(() =>
                host.React.createElement(ProjectsPanel, {
                    React: host.React,
                    projects,
                    sessions,
                    api
                })
            );
            widget.id = instanceId;
            widget.title.closable = true;
            widget.title.label = 'Projects';
            return widget;
        }
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Open Projects',
        execute: () => api.panels.open(PANEL_PROJECTS)
    });
}

interface ProjectsPanelProps {
    readonly React: PanelHostTools['React'];
    readonly projects: ProjectsService;
    readonly sessions: AgentSessionsView;
    readonly api: FrontendPluginAPI;
}

interface Actions {
    readonly addProject: () => Promise<void>;
    readonly addSession: (project: ProjectRecord, agent: AgentDescriptor) => Promise<void>;
    readonly resume: (project: ProjectRecord, session: ProjectSessionRecord) => Promise<void>;
    readonly archiveProject: (project: ProjectRecord, archived: boolean) => Promise<void>;
    readonly removeProject: (project: ProjectRecord) => Promise<void>;
    readonly archiveSession: (session: ProjectSessionRecord, archived: boolean) => Promise<void>;
    readonly removeSession: (session: ProjectSessionRecord) => Promise<void>;
    readonly confirm: (key: string | undefined) => void;
    readonly confirming: string | undefined;
    readonly busy: string | undefined;
    readonly pickerFor: string | undefined;
    readonly setPickerFor: (projectId: string | undefined) => void;
}

/** The project list itself: folders, their stored sessions, and archive sections. */
function ProjectsPanel(props: ProjectsPanelProps): ReactNS.ReactNode {
    const { React, projects, sessions, api } = props;
    const [snapshot, setSnapshot] = React.useState<ProjectsSnapshot>();
    const [agents, setAgents] = React.useState<readonly AgentDescriptor[]>([]);
    const [error, setError] = React.useState<string>();
    const [notice, setNotice] = React.useState<string>();
    const [busy, setBusy] = React.useState<string>();
    const [confirming, setConfirming] = React.useState<string>();
    const [pickerFor, setPickerFor] = React.useState<string>();
    const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
    const [showArchived, setShowArchived] = React.useState(false);

    const refresh = React.useCallback(async (): Promise<void> => {
        try {
            setSnapshot(await projects.refresh());
            setError(undefined);
        } catch (cause) {
            setError(messageOf(cause));
        }
    }, [projects]);

    React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    React.useEffect(() => {
        void sessions.listAgents()
            .then(list => setAgents(list))
            .catch(cause => setError(messageOf(cause)));
    }, [sessions]);

    // Escape closes whichever transient menu the user opened.
    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            setPickerFor(undefined);
            setConfirming(undefined);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
        setBusy(key);
        setError(undefined);
        setNotice(undefined);
        try {
            await operation();
            await refresh();
        } catch (cause) {
            setError(messageOf(cause));
        } finally {
            setBusy(undefined);
            setConfirming(undefined);
        }
    };

    const chatLauncher = (): AgentChatLauncherService | undefined => {
        if (!api.services.has(WORKSPACE_SERVICE_IDS.agentChat)) {
            return undefined;
        }
        return api.services.get<AgentChatLauncherService>(WORKSPACE_SERVICE_IDS.agentChat);
    };

    const dialogs = (): WorkspaceDialogsService | undefined => {
        if (!api.services.has(WORKSPACE_SERVICE_IDS.dialogs)) {
            return undefined;
        }
        return api.services.get<WorkspaceDialogsService>(WORKSPACE_SERVICE_IDS.dialogs);
    };

    const agentName = (agentId: string): string =>
        agents.find(agent => agent.id === agentId)?.name ?? agentId;

    const actions: Actions = {
        addProject: () => run('add-project', async () => {
            const picker = dialogs();
            if (!picker) {
                throw new Error('This Icebox build has no folder picker; update it and try again.');
            }
            const folder = await picker.pickDirectory({ title: 'Add project folder' });
            if (!folder) {
                return;
            }
            await projects.addProject(folder);
            setPickerFor(undefined);
            setShowArchived(false);
        }),
        addSession: (project, agent) => run(`session:${project.id}`, async () => {
            const launcher = chatLauncher();
            if (!launcher) {
                throw new Error('The Agent Chat plugin is not available, so a session cannot be started.');
            }
            const sessionId = newSessionId();
            // Record it before opening the tab: the agent starts immediately and
            // its first status event must find the project session already there.
            await projects.addSession(project.id, {
                id: sessionId,
                agentId: agent.id,
                title: `New ${agent.name} session`
            });
            try {
                await launcher.openChat({ agentId: agent.id, cwd: project.path, sessionId });
            } catch (cause) {
                await projects.removeSession(sessionId).catch(() => undefined);
                throw cause;
            }
            setPickerFor(undefined);
        }),
        resume: (project, session) => run(`resume:${session.id}`, async () => {
            const launcher = chatLauncher();
            if (!launcher) {
                throw new Error('The Agent Chat plugin is not available, so this session cannot be resumed.');
            }
            if (!session.resume) {
                setNotice(`"${session.title}" has no saved agent session yet; opened a new conversation in this project.`);
            }
            await launcher.openChat({
                agentId: session.agentId,
                cwd: project.path,
                sessionId: session.id,
                ...(session.resume ? { resume: session.resume } : {}),
                title: session.title
            });
        }),
        archiveProject: (project, archived) => run(`archive:${project.id}`, async () => {
            await projects.setProjectArchived(project.id, archived);
        }),
        removeProject: project => run(`delete:${project.id}`, async () => {
            await projects.removeProject(project.id);
        }),
        archiveSession: (session, archived) => run(`archive:${session.id}`, async () => {
            await projects.setSessionArchived(session.id, archived);
        }),
        removeSession: session => run(`delete:${session.id}`, async () => {
            await projects.removeSession(session.id);
        }),
        confirm: key => setConfirming(key),
        confirming,
        busy,
        pickerFor,
        setPickerFor
    };

    const allProjects = snapshot?.projects ?? [];
    const active = allProjects.filter(project => !project.archived).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const archived = allProjects.filter(project => project.archived);
    const archivedSessions = allProjects
        .flatMap(project => project.sessions.filter(session => session.archived).map(session => ({ project, session })))
        .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
    const archivedCount = archived.length + archivedSessions.length;

    const toggleProject = (projectId: string): void => {
        const next = new Set(collapsed);
        if (next.has(projectId)) {
            next.delete(projectId);
        } else {
            next.add(projectId);
        }
        setCollapsed(next);
    };

    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement(
            'div',
            { style: HEADER_STYLE },
            React.createElement('span', { style: TITLE_STYLE }, 'Projects'),
            React.createElement(
                'span',
                { style: HINT_STYLE },
                active.length === 0 ? '' : `${active.length} project${active.length === 1 ? '' : 's'}`
            ),
            React.createElement(
                'button',
                {
                    style: PRIMARY_BUTTON_STYLE,
                    title: 'Add a project folder',
                    disabled: busy === 'add-project',
                    onClick: () => void actions.addProject()
                },
                busy === 'add-project' ? 'Adding…' : '+ Add project'
            )
        ),
        error ? React.createElement('div', { style: ERROR_STYLE }, error) : undefined,
        notice ? React.createElement('div', { style: NOTICE_STYLE }, notice) : undefined,
        React.createElement(
            'div',
            { style: BODY_STYLE },
            snapshot === undefined
                ? React.createElement('div', { style: MUTED_STYLE }, 'Loading projects…')
                : active.length === 0
                    ? React.createElement(
                        'div',
                        { style: EMPTY_STYLE },
                        'No projects yet.',
                        React.createElement('div', { style: MUTED_STYLE }, 'Add a repository root or any folder to start agent sessions in it.')
                    )
                    : active.map(project => ProjectRow({
                        key: project.id,
                        React,
                        project,
                        agents,
                        actions,
                        agentName,
                        collapsed: collapsed.has(project.id),
                        toggle: () => toggleProject(project.id)
                    })),
            archivedCount > 0
                ? React.createElement(
                    'div',
                    { style: ARCHIVE_SECTION_STYLE },
                    React.createElement(
                        'button',
                        { style: ARCHIVE_TOGGLE_STYLE, onClick: () => setShowArchived(!showArchived) },
                        `${showArchived ? '▾' : '▸'} Archived (${archivedCount})`
                    ),
                    showArchived
                        ? [
                            ...archived.map(project => ArchivedProjectRow({ key: project.id, React, project, actions })),
                            ...archivedSessions.map(item => ArchivedSessionRow({
                                key: item.session.id,
                                React,
                                project: item.project,
                                session: item.session,
                                actions,
                                agentName
                            }))
                        ]
                        : undefined
                )
                : undefined
        )
    );
}

interface ProjectRowProps {
    readonly key: string;
    readonly React: PanelHostTools['React'];
    readonly project: ProjectRecord;
    readonly agents: readonly AgentDescriptor[];
    readonly actions: Actions;
    readonly agentName: (agentId: string) => string;
    readonly collapsed: boolean;
    readonly toggle: () => void;
}

/** One folder: its header actions, its agent picker, and its session rows. */
function ProjectRow(props: ProjectRowProps): ReactNS.ReactNode {
    const { React, project, agents, actions, agentName, collapsed, toggle } = props;
    const activeSessions = project.sessions
        .filter(session => !session.archived)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const pickerOpen = actions.pickerFor === project.id;
    const deleting = actions.confirming === `delete:${project.id}`;

    return React.createElement(
        'div',
        { key: props.key, style: PROJECT_STYLE },
        React.createElement(
            'div',
            { style: PROJECT_HEADER_STYLE },
            React.createElement(
                'button',
                { style: CHEVRON_STYLE, title: collapsed ? 'Expand' : 'Collapse', onClick: toggle },
                collapsed ? '▸' : '▾'
            ),
            React.createElement(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', { style: PROJECT_NAME_STYLE, title: project.path }, project.name),
                React.createElement('div', { style: PROJECT_PATH_STYLE, title: project.path }, project.path)
            ),
            React.createElement(
                'span',
                { style: HINT_STYLE },
                `${activeSessions.length} session${activeSessions.length === 1 ? '' : 's'}`
            ),
            React.createElement(
                'div',
                { style: { position: 'relative', display: 'flex', gap: '4px' } },
                React.createElement(
                    'button',
                    {
                        style: SMALL_BUTTON_STYLE,
                        title: 'Start an agent session in this project',
                        disabled: actions.busy !== undefined,
                        onClick: () => actions.setPickerFor(pickerOpen ? undefined : project.id)
                    },
                    '+'
                ),
                React.createElement(
                    'button',
                    {
                        style: SMALL_BUTTON_STYLE,
                        title: 'Archive this project',
                        disabled: actions.busy !== undefined,
                        onClick: () => void actions.archiveProject(project, true)
                    },
                    'Archive'
                ),
                deleting
                    ? ConfirmDelete({
                        React,
                        question: 'Delete project?',
                        busy: actions.busy === `delete:${project.id}`,
                        onCancel: () => actions.confirm(undefined),
                        onDelete: () => void actions.removeProject(project)
                    })
                    : React.createElement(
                        'button',
                        {
                            style: DANGER_BUTTON_STYLE,
                            disabled: actions.busy !== undefined,
                            onClick: () => actions.confirm(`delete:${project.id}`)
                        },
                        'Delete'
                    ),
                pickerOpen ? AgentPicker({
                    React,
                    agents,
                    busy: actions.busy === `session:${project.id}`,
                    onChoose: agent => void actions.addSession(project, agent),
                    onClose: () => actions.setPickerFor(undefined)
                }) : undefined
            )
        ),
        collapsed
            ? undefined
            : React.createElement(
                'div',
                { style: SESSION_LIST_STYLE },
                activeSessions.length === 0
                    ? React.createElement('div', { style: MUTED_ROW_STYLE }, 'No sessions yet — use + to start one.')
                    : activeSessions.map(session => SessionRow({ key: session.id, React, project, session, actions, agentName }))
            )
    );
}

interface SessionRowProps {
    readonly key: string;
    readonly React: PanelHostTools['React'];
    readonly project: ProjectRecord;
    readonly session: ProjectSessionRecord;
    readonly actions: Actions;
    readonly agentName: (agentId: string) => string;
}

/** One stored conversation: status, title, agent and the resume/archive/delete actions. */
function SessionRow(props: SessionRowProps): ReactNS.ReactNode {
    const { React, project, session, actions, agentName } = props;
    const deleting = actions.confirming === `delete:${session.id}`;
    return React.createElement(
        'div',
        { key: props.key, style: SESSION_ROW_STYLE },
        React.createElement('span', { style: statusDot(session.status) }),
        React.createElement(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: SESSION_TITLE_STYLE, title: session.title }, session.title),
            React.createElement(
                'div',
                { style: SESSION_META_STYLE },
                `${agentName(session.agentId)} · ${describeStatus(session.status)} · ${formatWhen(session.updatedAt)}`
            )
        ),
        React.createElement(
            'button',
            {
                style: SMALL_BUTTON_STYLE,
                title: session.resume ? 'Resume this agent session' : 'Open a new conversation in this project',
                disabled: actions.busy !== undefined,
                onClick: () => void actions.resume(project, session)
            },
            'Resume'
        ),
        React.createElement(
            'button',
            {
                style: SMALL_BUTTON_STYLE,
                disabled: actions.busy !== undefined,
                onClick: () => void actions.archiveSession(session, true)
            },
            'Archive'
        ),
        deleting
            ? ConfirmDelete({
                React,
                question: 'Delete?',
                busy: actions.busy === `delete:${session.id}`,
                onCancel: () => actions.confirm(undefined),
                onDelete: () => void actions.removeSession(session)
            })
            : React.createElement(
                'button',
                {
                    style: DANGER_BUTTON_STYLE,
                    disabled: actions.busy !== undefined,
                    onClick: () => actions.confirm(`delete:${session.id}`)
                },
                'Delete'
            )
    );
}

function ArchivedProjectRow(props: { key: string; React: PanelHostTools['React']; project: ProjectRecord; actions: Actions }): ReactNS.ReactNode {
    const { React, project, actions } = props;
    const deleting = actions.confirming === `delete:${project.id}`;
    return React.createElement(
        'div',
        { key: props.key, style: ARCHIVED_ROW_STYLE },
        React.createElement(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: PROJECT_NAME_STYLE }, project.name),
            React.createElement('div', { style: PROJECT_PATH_STYLE }, project.path)
        ),
        React.createElement(
            'button',
            { style: SMALL_BUTTON_STYLE, onClick: () => void actions.archiveProject(project, false) },
            'Restore'
        ),
        deleting
            ? ConfirmDelete({
                React,
                question: 'Delete?',
                busy: actions.busy === `delete:${project.id}`,
                onCancel: () => actions.confirm(undefined),
                onDelete: () => void actions.removeProject(project)
            })
            : React.createElement(
                'button',
                {
                    style: DANGER_BUTTON_STYLE,
                    onClick: () => actions.confirm(`delete:${project.id}`)
                },
                'Delete'
            )
    );
}

function ArchivedSessionRow(props: {
    key: string;
    React: PanelHostTools['React'];
    project: ProjectRecord;
    session: ProjectSessionRecord;
    actions: Actions;
    agentName: (agentId: string) => string;
}): ReactNS.ReactNode {
    const { React, project, session, actions, agentName } = props;
    const deleting = actions.confirming === `delete:${session.id}`;
    return React.createElement(
        'div',
        { key: props.key, style: ARCHIVED_ROW_STYLE },
        React.createElement(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: SESSION_TITLE_STYLE }, session.title),
            React.createElement(
                'div',
                { style: SESSION_META_STYLE },
                `${project.name} · ${agentName(session.agentId)} · ${formatWhen(session.updatedAt)}`
            )
        ),
        React.createElement(
            'button',
            { style: SMALL_BUTTON_STYLE, onClick: () => void actions.archiveSession(session, false) },
            'Restore'
        ),
        deleting
            ? ConfirmDelete({
                React,
                question: 'Delete?',
                busy: actions.busy === `delete:${session.id}`,
                onCancel: () => actions.confirm(undefined),
                onDelete: () => void actions.removeSession(session)
            })
            : React.createElement(
                'button',
                { style: DANGER_BUTTON_STYLE, onClick: () => actions.confirm(`delete:${session.id}`) },
                'Delete'
            )
    );
}

function ConfirmDelete(props: {
    React: PanelHostTools['React'];
    question: string;
    busy: boolean;
    onCancel: () => void;
    onDelete: () => void;
}): ReactNS.ReactNode {
    const { React, question, busy, onCancel, onDelete } = props;
    return React.createElement(
        'span',
        { style: CONFIRM_STYLE },
        React.createElement('span', { style: HINT_STYLE }, question),
        React.createElement(
            'button',
            { style: DANGER_BUTTON_STYLE, disabled: busy, onClick: onDelete },
            busy ? 'Deleting…' : 'Confirm'
        ),
        React.createElement('button', { style: SMALL_BUTTON_STYLE, onClick: onCancel }, 'Cancel')
    );
}

/** Installed agents first, unavailable ones dimmed: the same policy as agent-chat. */
function AgentPicker(props: {
    React: PanelHostTools['React'];
    agents: readonly AgentDescriptor[];
    busy: boolean;
    onChoose: (agent: AgentDescriptor) => void;
    onClose: () => void;
}): ReactNS.ReactNode {
    const { React, agents, busy, onChoose, onClose } = props;
    const sorted = agents.slice().sort(compareAgents);
    return React.createElement(
        'div',
        { style: PICKER_STYLE },
        React.createElement('div', { style: PICKER_TITLE_STYLE }, 'Start a session with'),
        sorted.map(agent => React.createElement(
            'button',
            {
                key: agent.id,
                style: agent.available ? PICKER_ROW_STYLE : PICKER_ROW_DISABLED_STYLE,
                disabled: busy || !agent.available,
                title: `${agent.command} ${agent.args.join(' ')}`.trim(),
                onClick: () => onChoose(agent)
            },
            React.createElement('span', { style: PICKER_NAME_STYLE }, agent.name),
            React.createElement('span', { style: HINT_STYLE }, agent.available ? protocolLabel(agent.protocol) : 'not installed')
        )),
        sorted.length === 0 ? React.createElement('div', { style: MUTED_ROW_STYLE }, 'No agents discovered.') : undefined,
        React.createElement(
            'button',
            { style: PICKER_CLOSE_STYLE, onClick: onClose },
            'Cancel'
        )
    );
}

function compareAgents(left: AgentDescriptor, right: AgentDescriptor): number {
    if (left.available !== right.available) {
        return left.available ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
}

function protocolLabel(protocol: AgentDescriptor['protocol']): string {
    return protocol === 'pi-rpc' ? 'Pi RPC' : 'ACP';
}

function describeStatus(status: ProjectSessionRecord['status'] | undefined): string {
    switch (status) {
        case 'running':
            return 'working';
        case 'starting':
            return 'connecting';
        case 'error':
            return 'error';
        default:
            return 'idle';
    }
}

/** A coloured dot per status; the Git tokens need fallbacks because this build ships no Git extension. */
function statusDot(status: ProjectSessionRecord['status'] | undefined): ReactNS.CSSProperties {
    const color = status === 'error'
        ? 'var(--theia-errorForeground)'
        : status === 'running' || status === 'starting'
            ? 'var(--theia-gitDecoration-modifiedResourceForeground, #e2c08d)'
            : 'var(--theia-gitDecoration-untrackedResourceForeground, #73c991)';
    return {
        flexShrink: 0,
        width: '7px',
        height: '7px',
        marginTop: '4px',
        borderRadius: '50%',
        background: color
    };
}

/** Relative age for the list: minutes, hours, then a short date. */
function formatWhen(iso: string): string {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) {
        return 'unknown';
    }
    const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    if (days < 30) {
        return `${days}d ago`;
    }
    return new Date(time).toLocaleDateString();
}

function newSessionId(): string {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `projects-${random}`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// --------------------------------------------------------------------------- styles

const PANEL_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    background: 'var(--theia-editor-background)',
    color: 'var(--theia-editor-foreground)',
    fontFamily: 'var(--theia-ui-font-family)',
    fontSize: 'var(--theia-ui-font-size1)'
};

const HEADER_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    borderBottom: '1px solid var(--theia-panel-border)'
};

const TITLE_STYLE: ReactNS.CSSProperties = {
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontSize: '11px',
    opacity: 0.7
};

const HINT_STYLE: ReactNS.CSSProperties = {
    opacity: 0.65,
    fontSize: '11px',
    whiteSpace: 'nowrap'
};

const BODY_STYLE: ReactNS.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
};

const PROJECT_STYLE: ReactNS.CSSProperties = {
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '4px',
    background: 'var(--theia-sideBar-background)'
};

const PROJECT_HEADER_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    padding: '6px 8px'
};

const PROJECT_NAME_STYLE: ReactNS.CSSProperties = {
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

const PROJECT_PATH_STYLE: ReactNS.CSSProperties = {
    opacity: 0.6,
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

const CHEVRON_STYLE: ReactNS.CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    padding: '0 2px',
    fontSize: '12px',
    lineHeight: '18px'
};

const SESSION_LIST_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '0 8px 8px 22px'
};

const SESSION_ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    padding: '4px 6px',
    borderRadius: '3px'
};

const SESSION_TITLE_STYLE: ReactNS.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

const SESSION_META_STYLE: ReactNS.CSSProperties = {
    opacity: 0.6,
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

const SMALL_BUTTON_STYLE: ReactNS.CSSProperties = {
    flexShrink: 0,
    padding: '2px 6px',
    fontSize: '11px',
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer'
};

const DANGER_BUTTON_STYLE: ReactNS.CSSProperties = {
    ...SMALL_BUTTON_STYLE,
    background: 'transparent',
    color: 'var(--theia-errorForeground)',
    border: '1px solid var(--theia-errorForeground)'
};

const PRIMARY_BUTTON_STYLE: ReactNS.CSSProperties = {
    marginLeft: 'auto',
    flexShrink: 0,
    padding: '3px 8px',
    fontSize: '11px',
    background: 'var(--theia-button-background)',
    color: 'var(--theia-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer'
};

const PICKER_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    top: '24px',
    right: 0,
    zIndex: 10,
    minWidth: '230px',
    padding: '4px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    background: 'var(--theia-menu-background)',
    color: 'var(--theia-menu-foreground)',
    border: '1px solid var(--theia-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)'
};

const PICKER_TITLE_STYLE: ReactNS.CSSProperties = {
    opacity: 0.6,
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '2px 6px'
};

const PICKER_ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    width: '100%',
    padding: '3px 6px',
    background: 'transparent',
    color: 'inherit',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 'inherit'
};

const PICKER_ROW_DISABLED_STYLE: ReactNS.CSSProperties = {
    ...PICKER_ROW_STYLE,
    opacity: 0.45,
    cursor: 'default'
};

const PICKER_NAME_STYLE: ReactNS.CSSProperties = {
    fontWeight: 600
};

const PICKER_CLOSE_STYLE: ReactNS.CSSProperties = {
    ...SMALL_BUTTON_STYLE,
    marginTop: '2px',
    alignSelf: 'flex-end'
};

const CONFIRM_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px'
};

const ARCHIVE_SECTION_STYLE: ReactNS.CSSProperties = {
    marginTop: '4px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
};

const ARCHIVE_TOGGLE_STYLE: ReactNS.CSSProperties = {
    alignSelf: 'flex-start',
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    opacity: 0.7,
    cursor: 'pointer',
    padding: '2px 0',
    fontSize: '11px'
};

const ARCHIVED_ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    opacity: 0.75,
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '4px'
};

const EMPTY_STYLE: ReactNS.CSSProperties = {
    padding: '24px 8px',
    textAlign: 'center',
    opacity: 0.8
};

const MUTED_STYLE: ReactNS.CSSProperties = {
    opacity: 0.65,
    fontSize: '11px'
};

const MUTED_ROW_STYLE: ReactNS.CSSProperties = {
    ...MUTED_STYLE,
    padding: '4px 6px'
};

const ERROR_STYLE: ReactNS.CSSProperties = {
    margin: '8px 10px 0',
    padding: '6px 8px',
    color: 'var(--theia-errorForeground)',
    border: '1px solid var(--theia-errorForeground)',
    borderRadius: '3px',
    fontSize: '11px'
};

const NOTICE_STYLE: ReactNS.CSSProperties = {
    margin: '8px 10px 0',
    padding: '6px 8px',
    color: 'var(--theia-descriptionForeground)',
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '3px',
    fontSize: '11px'
};
