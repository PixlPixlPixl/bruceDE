import type * as ReactNS from 'react';
import type {
    AgentChatLauncherService,
    AgentChatOpenOptions,
    AgentSessionHandle,
    AgentSessionSummary,
    FrontendPluginAPI,
    PanelHostTools,
    PanelSavedState,
    PanelState,
    ResourceStat,
    WorkspaceResourcesService
} from '@icebox/plugin-api';
import { AGENT_PROTOCOL_LABELS, WORKSPACE_SERVICE_IDS } from '@icebox/plugin-api';
import type {
    AgentCommand,
    AgentDescriptor,
    AgentModelInfo,
    AgentProtocol,
    AgentSessionsService,
    AgentState
} from '../shared.js';

const PANEL_CHAT = 'agent-chat.conversation';
const COMMAND_OPEN = 'icebox.agent-chat.open';
/**
 * Timer used only when the runtime cannot push (an older runtime, or one that
 * failed mid-wait). The normal path holds a pending `waitForChange` instead.
 */
const POLL_FALLBACK_MS = 1000;
/**
 * How often the agent list is re-read.
 *
 * It is plugin data, so it only changes when the user enables or disables a
 * plugin in the manager; the panel does not need to notice within a second, and
 * the backend answers from the host catalogue plus a short cache of `PATH`
 * lookups.
 */
const AGENT_LIST_INTERVAL_MS = 4_000;
/** Rows offered by one search before the user has narrowed it down. */
const MODEL_ROWS = 40;
/** Completion rows rendered at once; the rest is reached by typing. */
const COMPLETION_ROWS = 8;
/** Files listed per `@` completion query. */
const FILE_ROWS = 40;
/**
 * The composer grows with its content up to this height and scrolls beyond it.
 * Fixed in pixels so a narrow panel and a wide one stop growing at the same
 * point instead of depending on the window height.
 */
const COMPOSER_MAX_HEIGHT = 240;

/**
 * Native renderer entrypoint for agent chat.
 *
 * One panel instance is one chat session: the instance id *is* the backend
 * session id, and the agent it talks to travels in the panel state, so the host
 * persists and restores it with the rest of the layout. Opening another chat
 * therefore never touches the one already on screen.
 */
export function activate(api: FrontendPluginAPI): void {
    const sessions = api.services.remote<AgentSessionsService>(WORKSPACE_SERVICE_IDS.agentSessions);
    const resources = api.services.get<WorkspaceResourcesService>(WORKSPACE_SERVICE_IDS.resources);

    // Mounted containers, so a chat opened from elsewhere lands in the panel the
    // user already has instead of a second one. The entry is created with the
    // widget and dropped when the shell disposes it.
    const containers = new Map<string, ContainerBridge>();
    /** The container a caller most recently used, preferred over the rest. */
    let preferred: string | undefined;

    const mountedContainer = (): ContainerBridge | undefined => {
        const first = preferred === undefined ? undefined : containers.get(preferred);
        if (first?.mounted) {
            return first;
        }
        for (const bridge of containers.values()) {
            if (bridge.mounted) {
                return bridge;
            }
        }
        return undefined;
    };

    /**
     * Puts a chat on screen: as a tab of the mounted container, or as the first
     * tab of a new one.
     *
     * A container is a place conversations live side by side, so opening a chat
     * never opens a second agent-chat panel. Only when none is mounted does this
     * create one, and it starts with a single tab.
     */
    const launchChat = async (options: AgentChatOpenOptions): Promise<string> => {
        const mounted = mountedContainer();
        if (mounted) {
            mounted.mounted.open(options);
            preferred = mounted.instanceId;
            await api.panels.activate(mounted.instanceId).catch(() => undefined);
            return mounted.instanceId;
        }
        const tab = tabFrom(options);
        const state: PanelState = { tabs: [stateOf(tab)], activeTab: tab.sessionId };
        return api.panels.open(PANEL_CHAT, { state });
    };

    // Panel ids are namespaced per plugin, so another plugin (Projects) cannot
    // open this chat through `panels.open`. It uses this launcher instead, which
    // stays owned by agent-chat and keeps the panel under this plugin's disposal.
    api.services.provide<AgentChatLauncherService>(WORKSPACE_SERVICE_IDS.agentChat, {
        openChat: launchChat
    });

    api.panels.register({
        id: PANEL_CHAT,
        title: 'Agent Chat',
        createWidget: (instanceId, host, state) => {
            const bridge: ContainerBridge = { instanceId };
            containers.set(instanceId, bridge);
            const saved: PanelSavedState = {
                // A widget that stores nothing is dropped from the saved layout
                // entirely, so this never returns undefined.
                store: () => bridge.mounted?.snapshot() ?? bridge.pending ?? { tabs: [] },
                restore: state => {
                    if (bridge.mounted) {
                        bridge.mounted.apply(state);
                    } else {
                        // `restore` runs before the widget is attached, so the
                        // component reads it on mount.
                        bridge.pending = state;
                    }
                }
            };
            const widget = host.createReactWidget(
                () =>
                    host.React.createElement(AgentChatPanel, {
                        React: host.React,
                        sessions,
                        resources,
                        bridge,
                        onUsed: () => {
                            preferred = instanceId;
                        },
                        initialState: state
                    }),
                saved
            );
            widget.id = instanceId;
            widget.title.closable = true;
            widget.title.label = 'Agent Chat';
            widget.disposed.connect(() => {

                // A disposed widget is detached, not unmounted: React never runs
                // effect cleanup for a node the shell removed, so the sessions
                // behind this panel have to be released here.
                bridge.mounted?.dispose();
                containers.delete(instanceId);
                if (preferred === instanceId) {
                    preferred = undefined;
                }
            });
            return widget;
        }
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Open Agent Chat',
        execute: async () => {
            const agents = await sessions.listAgents();
            const first = availableAgents(agents)[0];
            if (!first) {
                // No agent installed: show the container's own empty state.
                const mounted = mountedContainer();
                return mounted ? mounted.instanceId : api.panels.open(PANEL_CHAT);
            }
            return launchChat({ agentId: first.id });
        }
    });
}

/** One session tab: everything needed to open, and later re-open, a chat. */
interface ChatTab {
    readonly sessionId: string;
    readonly agentId: string;
    readonly cwd?: string;
    readonly resume?: AgentSessionHandle;
    /** Caller-supplied tab label (a project session's title). */
    readonly title?: string;
}

/**
 * The plugin's side of a mounted container.
 *
 * `open` is how the launcher adds a chat to the container the user already has;
 * `snapshot` and `apply` are what the layout restorer stores and replays, because
 * a panel's construction options are fixed at creation and its tab list is not.
 */
interface MountedContainer {
    open(options: AgentChatOpenOptions): void;
    snapshot(): PanelState;
    apply(state: PanelState | undefined): void;
    /** Releases every session this container holds; safe to call twice. */
    dispose(): void;
}

interface ContainerBridge {
    readonly instanceId: string;
    /** Present only while the React tree is mounted. */
    mounted?: MountedContainer;
    /** State saved by the layout restorer, read on mount. */
    pending?: PanelState;
}

/** Chat session ids are opaque to the backend; only their stability matters. */
let chatCounter = 0;
function newChatId(): string {
    chatCounter += 1;
    return `chat-${Date.now().toString(36)}-${chatCounter}`;
}

function tabFrom(options: AgentChatOpenOptions): ChatTab {
    return {
        sessionId: options.sessionId ?? newChatId(),
        agentId: options.agentId,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        ...(options.title === undefined ? {} : { title: options.title })
    };
}

function stateOf(tab: ChatTab): PanelState {
    return {
        sessionId: tab.sessionId,
        agentId: tab.agentId,
        ...(tab.cwd === undefined ? {} : { cwd: tab.cwd }),
        ...(tab.resume === undefined ? {} : { resume: tab.resume }),
        ...(tab.title === undefined ? {} : { title: tab.title })
    };
}

/** True for a handle read back from panel state, ignoring malformed data. */
function isSessionHandle(value: unknown): value is AgentSessionHandle {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.agentId === 'string'
        && typeof record.sessionId === 'string'
        && (record.protocol === 'acp' || record.protocol === 'pi-rpc');
}

/** One tab, read back from saved panel state. Malformed entries are dropped. */
function readTab(value: unknown): ChatTab | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId !== 'string' || typeof record.agentId !== 'string') {
        return undefined;
    }
    const resume = isSessionHandle(record.resume) ? record.resume : undefined;
    return {
        sessionId: record.sessionId,
        agentId: record.agentId,
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
        ...(resume === undefined ? {} : { resume }),
        ...(typeof record.title === 'string' ? { title: record.title } : {})
    };
}

function readTabs(state: PanelState | undefined): readonly ChatTab[] {
    const tabs = state?.tabs;
    if (!Array.isArray(tabs)) {
        return [];
    }
    return tabs.map(readTab).filter((tab): tab is ChatTab => tab !== undefined);
}

/**
 * The single-session state an older build opened a panel with.
 *
 * Migrated into a one-tab container so a restored layout keeps working, and so
 * there is only one agent-chat panel type.
 */
function readLegacyTab(state: PanelState | undefined): ChatTab | undefined {
    const agentId = state?.agentId;
    if (typeof agentId !== 'string') {
        return undefined;
    }
    return readTab({
        sessionId: typeof state?.sessionId === 'string' ? state.sessionId : newChatId(),
        agentId,
        cwd: state?.cwd,
        resume: state?.resume,
        title: state?.title
    });
}

function readActive(state: PanelState | undefined, tabs: readonly ChatTab[]): string | undefined {
    const active = state?.activeTab;
    if (typeof active === 'string' && tabs.some(tab => tab.sessionId === active)) {
        return active;
    }
    return tabs[0]?.sessionId;
}

/** How often a tab's own status and title are re-read. `summary` is built for it. */
const TAB_SUMMARY_INTERVAL_MS = 2_000;

interface AgentChatPanelProps {
    readonly React: PanelHostTools['React'];
    readonly sessions: AgentSessionsService;
    readonly resources: WorkspaceResourcesService;
    readonly bridge: ContainerBridge;
    readonly initialState?: PanelState;
    readonly onUsed: () => void;
}

/**
 * The panel: a strip of session tabs over the chat of the active one.
 *
 * A conversation lives in a tab, not in the panel, so closing a tab disconnects
 * that agent while the others keep running and the panel stays where it is.
 * Closing the panel itself releases every session it holds.
 */
function AgentChatPanel(props: AgentChatPanelProps): ReactNS.ReactNode {
    const { React, sessions, resources, bridge, onUsed } = props;
    const initial = bridge.pending ?? props.initialState;
    const [tabs, setTabs] = React.useState<readonly ChatTab[]>(() => {
        const saved = readTabs(initial);
        if (saved.length > 0) {
            return saved;
        }
        const legacy = readLegacyTab(initial);
        return legacy ? [legacy] : [];
    });
    const [active, setActive] = React.useState<string | undefined>(() => {
        const saved = readTabs(initial);
        if (saved.length > 0) {
            return readActive(initial, saved);
        }
        const legacy = readLegacyTab(initial);
        return legacy?.sessionId;
    });
    const [agents, setAgents] = React.useState<readonly AgentDescriptor[]>([]);
    const [summaries, setSummaries] = React.useState<Readonly<Record<string, AgentSessionSummary>>>({});
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [notice, setNotice] = React.useState<string>();

    // The bridge outlives a render, so it reads the latest values through refs.
    const tabsRef = React.useRef(tabs);
    tabsRef.current = tabs;
    const activeRef = React.useRef(active);
    activeRef.current = active;

    const addTab = (options: AgentChatOpenOptions): string => {
        const current = tabsRef.current;
        if (options.sessionId !== undefined) {
            const existing = current.find(tab => tab.sessionId === options.sessionId);
            if (existing) {
                setActive(existing.sessionId);
                return existing.sessionId;
            }
        }
        const tab = tabFrom(options);
        setTabs([...current, tab]);
        setActive(tab.sessionId);
        setNotice(undefined);
        return tab.sessionId;
    };
    const addRef = React.useRef(addTab);
    addRef.current = addTab;

    const closeTab = (sessionId: string): void => {
        const remaining = tabsRef.current.filter(tab => tab.sessionId !== sessionId);
        setTabs(remaining);
        if (activeRef.current === sessionId) {
            setActive(remaining[remaining.length - 1]?.sessionId);
        }
        // The tab was the session's lifeline: closing it disconnects the agent.
        void sessions.release(sessionId).catch(() => undefined);
    };

    // Publish the live tab list, and undo it when the panel itself goes away.
    const liveIds = React.useRef<readonly string[]>([]);
    liveIds.current = tabs.map(tab => tab.sessionId);

    // Releases every session the container holds: a closed panel disconnects all
    // of its agents. Safe to call twice, because `release` is a no-op for a
    // session the backend no longer has.
    const releaseAll = React.useCallback((): void => {

        for (const sessionId of liveIds.current) {
            void sessions.release(sessionId).catch(() => undefined);
        }
    }, [sessions]);

    // Publish the live tab list, and undo it when the panel itself goes away.
    React.useEffect(() => {
        bridge.mounted = {
            open: options => {
                addRef.current(options);
                onUsed();
            },
            snapshot: () => ({
                tabs: tabsRef.current.map(stateOf),
                ...(activeRef.current === undefined ? {} : { activeTab: activeRef.current })
            }),
            apply: state => {
                const next = readTabs(state);
                setTabs(next);
                setActive(readActive(state, next));
            },
            dispose: releaseAll
        };
        bridge.pending = undefined;
        return () => {
            bridge.mounted = undefined;
        };
    }, [bridge, onUsed, releaseAll]);

    React.useEffect(() => releaseAll, [releaseAll]);

    // Agent list: plugin data, so it only changes when the manager does.
    React.useEffect(() => {
        let cancelled = false;
        const refresh = async (): Promise<void> => {
            try {
                const list = await sessions.listAgents();
                if (!cancelled) {
                    setAgents(list);
                }
            } catch {
                // A missing agent list is not fatal: the strip keeps its tabs.
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), AGENT_LIST_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [sessions]);

    // Tab labels and busy dots come from `summary`, which is made to be polled.
    const tabIds = tabs.map(tab => tab.sessionId).join('|');
    React.useEffect(() => {
        if (tabIds.length === 0) {
            setSummaries({});
            return;
        }
        let cancelled = false;
        const read = async (): Promise<void> => {
            const rows = await Promise.all(
                tabIds.split('|').map(sessionId => sessions.summary(sessionId).catch(() => undefined))
            );
            if (cancelled) {
                return;
            }
            const next: Record<string, AgentSessionSummary> = {};
            for (const row of rows) {
                if (row) {
                    next[row.sessionId] = row;
                }
            }
            setSummaries(next);
            // The agent reports the handle and title it learned *after* the tab
            // opened. Storing them here is what lets a restored tab continue the
            // same agent-side conversation instead of starting a new one.
            setTabs(current => {
                let changed = false;
                const patched = current.map(tab => {
                    const summary = next[tab.sessionId];
                    if (!summary) {
                        return tab;
                    }
                    const resume = summary.resume ?? tab.resume;
                    const title = tab.title ?? summary.title;
                    if (resume === tab.resume && title === tab.title) {
                        return tab;
                    }
                    changed = true;
                    return {
                        ...tab,
                        ...(resume === undefined ? {} : { resume }),
                        ...(title === undefined ? {} : { title })
                    };
                });
                return changed ? patched : current;
            });
        };
        void read();
        const timer = setInterval(() => void read(), TAB_SUMMARY_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [tabIds, sessions]);

    const installed = availableAgents(agents);
    const missing = unavailableAgents(agents);

    const label = (tab: ChatTab): string => {
        if (tab.title) {
            return tab.title;
        }
        const title = summaries[tab.sessionId]?.title;
        if (title) {
            return title;
        }
        return agents.find(agent => agent.id === tab.agentId)?.name ?? tab.agentId;
    };

    const pickAgent = (agent: AgentDescriptor): void => {
        setPickerOpen(false);
        if (!agent.available) {
            return;
        }
        addTab({ agentId: agent.id });
    };

    /** The empty panel: nothing is open, and the two ways to start something. */
    const startFirstChat = (): void => {
        const first = installed[0];
        if (!first) {
            setNotice('No agent CLI is installed yet. Enable an agent plugin in the Plugin Manager first.');
            return;
        }
        addTab({ agentId: first.id });
    };

    const renderEmpty = (): ReactNS.ReactNode =>
        React.createElement(
            'div',
            { style: EMPTY_STYLE },
            React.createElement('div', { style: EMPTY_TITLE_STYLE }, 'No Current Sessions'),
            React.createElement(
                'div',
                { style: EMPTY_TEXT_STYLE },
                'A chat lives in a tab. Close a tab to disconnect its agent; the panel stays open.'
            ),
            React.createElement(
                'button',
                { type: 'button', style: EMPTY_ACTION_STYLE, onClick: startFirstChat },
                'Start a new chat.'
            ),
            React.createElement(
                'button',
                {
                    type: 'button',
                    style: EMPTY_ACTION_STYLE,
                    onClick: () => setNotice(
                        'Add a folder as a project in the Projects panel, then start a session there: '
                        + 'it opens as a tab in this panel, already scoped to that folder.'
                    )
                },
                'Start a new project session from the Projects panel.'
            ),
            notice ? React.createElement('div', { style: EMPTY_NOTICE_STYLE }, notice) : undefined
        );

    const strip = React.createElement(
        'div',
        { style: TAB_STRIP_STYLE },
        React.createElement(
            'div',
            { style: TAB_ROW_STYLE },
            tabs.map(tab =>
                React.createElement(
                    'div',
                    {
                        key: tab.sessionId,
                        style: tab.sessionId === active ? { ...TAB_STYLE, ...TAB_ACTIVE_STYLE } : TAB_STYLE,
                        onClick: () => {
                            setActive(tab.sessionId);
                            onUsed();
                        }
                    },
                    React.createElement(
                        'span',
                        { style: TAB_LABEL_STYLE, title: tab.cwd ?? label(tab) },
                        label(tab)
                    ),
                    summaries[tab.sessionId]?.status === 'running' || summaries[tab.sessionId]?.status === 'starting'
                        ? React.createElement('span', { style: TAB_BUSY_STYLE, title: 'The agent is working.' })
                        : undefined,
                    React.createElement(
                        'button',
                        {
                            type: 'button',
                            style: TAB_CLOSE_STYLE,
                            title: 'Close this session and disconnect its agent',
                            'aria-label': `Close ${label(tab)}`,
                            onClick: (event: ReactNS.MouseEvent) => {
                                event.stopPropagation();
                                closeTab(tab.sessionId);
                            }
                        },
                        renderCrossGlyph(React)
                    )
                )
            )
        ),
        // Outside the scrolling tab row, so the picker is not clipped by it.
        React.createElement(
            'div',
            { style: PICKER_ANCHOR_STYLE },
            React.createElement(
                'button',
                {
                    type: 'button',
                    style: NEW_CHAT_BUTTON_STYLE,
                    title: 'Start a new chat in your home folder',
                    'aria-label': 'New chat',
                    onClick: () => setPickerOpen(open => !open)
                },
                renderPlusGlyph(React)
            ),
            pickerOpen ? renderPicker(React, installed, missing, pickAgent) : undefined
        ),
        pickerOpen
            ? React.createElement('div', {
                style: PICKER_BACKDROP_STYLE,
                onClick: () => setPickerOpen(false)
            })
            : undefined
    );

    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        strip,
        tabs.length === 0 ? renderEmpty() : undefined,
        tabs.map(tab =>
            React.createElement(
                'div',
                {
                    key: tab.sessionId,
                    style: tab.sessionId === active ? CHAT_SLOT_STYLE : CHAT_SLOT_HIDDEN_STYLE
                },
                // Every open tab stays mounted, so switching tabs keeps a
                // half-written prompt, the scroll position and the turn in flight
                // exactly where they were. Hidden tabs keep their layout (only
                // visibility differs), which the composer needs to measure itself.
                React.createElement(AgentChat, {
                    React,
                    sessions,
                    resources,
                    sessionId: tab.sessionId,
                    agentId: tab.agentId,
                    cwd: tab.cwd,
                    resume: tab.resume
                })
            )
        )
    );
}

/** Human name of the wire protocol, shown next to an agent and in the header. */
function protocolLabel(protocol: AgentProtocol | undefined): string {
    if (!protocol) {
        return '';
    }
    // A protocol can come from a plugin that this build does not name; showing
    // the id is better than an empty badge that hides which link is in use.
    return AGENT_PROTOCOL_LABELS[protocol] ?? protocol;
}

/**
 * How an agent is reached, primary interface first.
 *
 * AG-UI is tried before the agent's own protocol, so an agent with an endpoint
 * shows both: AG-UI is what it normally uses, and the other name is what it falls
 * back to when the endpoint is not answering.
 */
function protocolSummary(agent: AgentDescriptor): string {
    const native = protocolLabel(agent.protocol);
    return agent.agui ? `AG-UI · ${native}` : native;
}

/** Installed agents, alphabetically: what the picker offers at full colour. */
function availableAgents(agents: readonly AgentDescriptor[]): AgentDescriptor[] {
    return agents
        .filter(agent => agent.available)
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
}

/** Supported but not installed agents, alphabetically: shown dimmed. */
function unavailableAgents(agents: readonly AgentDescriptor[]): AgentDescriptor[] {
    return agents
        .filter(agent => !agent.available)
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
}

/** Which trigger opened the composer's completion menu. */
type CompletionKind = 'command' | 'file' | 'shell';

interface CompletionItem {
    /** Text inserted in place of the trigger token. */
    readonly insert: string;
    readonly label: string;
    readonly detail?: string;
}

interface CompletionView {
    readonly kind: CompletionKind;
    /** Index of the trigger character in the composer value. */
    readonly start: number;
    readonly query: string;
    readonly items: readonly CompletionItem[];
    readonly selected: number;
    readonly hint?: string;
}

/** The trigger token at the caret: `/`, `@` or `!` plus what follows it. */
function tokenAt(value: string, caret: number): { kind: CompletionKind; start: number; query: string } | undefined {
    const before = value.slice(0, caret);
    const start = before.search(/[^\s]\S*$/);
    if (start === -1) {
        return undefined;
    }
    const token = before.slice(start);
    const trigger = token[0];
    if (trigger !== '/' && trigger !== '@' && trigger !== '!') {
        return undefined;
    }
    const kind: CompletionKind = trigger === '/' ? 'command' : trigger === '@' ? 'file' : 'shell';
    return { kind, start, query: token.slice(1) };
}

interface AgentChatProps {
    readonly React: PanelHostTools['React'];
    readonly sessions: AgentSessionsService;
    readonly resources: WorkspaceResourcesService;
    /** Backend session this tab holds; unique per open tab. */
    readonly sessionId: string;
    readonly agentId: string;
    /** Folder the agent runs in; absent means the user's home directory. */
    readonly cwd?: string;
    /** Agent-side handle to continue an earlier conversation. */
    readonly resume?: AgentSessionHandle;
}

/** One chat session: header, transcript, composer. */
function AgentChat(props: AgentChatProps): ReactNS.ReactNode {
    const { React, sessions, resources } = props;
    // One tab is one session. The container decides which sessions exist and when
    // they end, so this view only binds, follows and renders its own.
    const sessionId = props.sessionId;
    const agentId = props.agentId;
    const initialCwd = props.cwd;
    const initialResume = props.resume;
    const [state, setState] = React.useState<AgentState>();
    const [input, setInput] = React.useState('');
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
    const [modelQuery, setModelQuery] = React.useState('');
    const [modelRows, setModelRows] = React.useState<readonly AgentModelInfo[]>([]);
    const [completion, setCompletion] = React.useState<CompletionView>();
    const scroller = React.useRef<HTMLDivElement>(null);
    const composer = React.useRef<HTMLTextAreaElement>(null);
    const modelFilter = React.useRef<HTMLInputElement>(null);
    const pendingCaret = React.useRef<number | undefined>(undefined);
    const fileLookup = React.useRef(0);

    // Bind this panel's session to its agent; switching agents rebinds in place.
    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            if (!agentId) {
                setState(undefined);
                return;
            }
            try {
                // The resume handle belongs to the agent it was recorded for; a
                // later switch to another agent must start that agent fresh.
                const resume = initialResume && initialResume.agentId === agentId ? initialResume : undefined;
                const options = {
                    ...(initialCwd === undefined ? {} : { cwd: initialCwd }),
                    ...(resume === undefined ? {} : { resume })
                };
                const next = await sessions.openSession(sessionId, agentId, options);
                if (!cancelled) {
                    setState(next);
                }
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [agentId, initialCwd, initialResume, sessionId, sessions]);

    // The container owns this session's lifetime: it releases the session when
    // the tab closes, and every remaining one when the panel itself goes away.
    // A view that unmounted on a tab switch must not disconnect the agent.

    // Follow the session while the panel is mounted.
    //
    // The runtime holds the panel's request open and answers it the moment the
    // session changes (`waitForChange`), so there is no timer and no wasted work:
    // one pending call, one incremental read per actual change. The read is still
    // needed because the answer is a revision, not the state itself, and because
    // events travel by cursor rather than being pushed.
    React.useEffect(() => {
        if (!agentId) {
            return;
        }
        let cancelled = false;
        let revision = 0;

        const read = async (): Promise<boolean> => {
            try {
                const next = await sessions.state(sessionId);
                if (cancelled) {
                    return false;
                }
                setState(next);
                revision = next.revision ?? revision;
                setError(undefined);
                return true;
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
                return false;
            }
        };

        /** Waits for a change, falling back to a timer if the runtime cannot push. */
        const waitForChange = async (): Promise<void> => {
            if (typeof sessions.waitForChange === 'function') {
                try {
                    revision = (await sessions.waitForChange(sessionId, revision)) ?? revision;
                    return;
                } catch {
                    // A runtime that vanished mid-wait must not spin: fall through
                    // to the timer for this round.
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLL_FALLBACK_MS));
        };

        const follow = async (): Promise<void> => {
            await read();
            while (!cancelled) {
                await waitForChange();
                if (cancelled) {
                    return;
                }
                await read();
            }
        };
        void follow();
        return () => {
            cancelled = true;
        };
    }, [agentId, sessionId, sessions]);

    // Keep the newest entry in view.
    React.useEffect(() => {
        const element = scroller.current;
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, [state?.entries.length, state?.status]);

    // Restore the caret after a completion inserted text.
    React.useLayoutEffect(() => {
        const caret = pendingCaret.current;
        const element = composer.current;
        if (caret !== undefined && element) {
            element.setSelectionRange(caret, caret);
            pendingCaret.current = undefined;
        }
    }, [input]);

    // The composer wraps its content instead of being drag-resized: measure the
    // content and set the height, scrolling only once the cap is reached.
    React.useLayoutEffect(() => {
        const element = composer.current;
        if (!element) {
            return;
        }
        element.style.height = 'auto';
        const fits = element.scrollHeight + 2;
        element.style.height = `${Math.min(fits, COMPOSER_MAX_HEIGHT)}px`;
        element.style.overflowY = fits > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
    }, [input]);

    // Typing while the model list is open filters it: the filter input takes
    // focus as soon as the menu appears, so no keystroke has to be lost.
    React.useLayoutEffect(() => {
        if (modelMenuOpen) {
            modelFilter.current?.focus();
        }
    }, [modelMenuOpen]);

    // Escape closes whichever menu is open. Outside clicks are handled by the
    // backdrops below: a document-level listener would dismiss on `mousedown`,
    // before the `click` could land on the row the user aimed at.
    React.useEffect(() => {
        if (!modelMenuOpen && !completion) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            setModelMenuOpen(false);
            setCompletion(undefined);
            composer.current?.focus();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [modelMenuOpen, completion]);

    // Model search runs in the backend: Pi reports thousands of models, so the
    // picker asks for a filtered slice instead of holding the whole catalogue.
    const searchModels = React.useCallback(
        (query: string): void => {
            if (!agentId) {
                return;
            }
            void sessions.searchModels(sessionId, query, MODEL_ROWS)
                .then(rows => setModelRows(rows))
                .catch(() => setModelRows([]));
        },
        [agentId, sessionId, sessions]
    );

    const chooseModel = async (model: AgentModelInfo): Promise<void> => {
        setModelMenuOpen(false);
        try {
            setState(await sessions.selectModel(sessionId, model.key));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const chooseThinking = async (level: string): Promise<void> => {
        try {
            setState(await sessions.selectThinking(sessionId, level));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    /** Recomputes the completion menu for the caret position. */
    const refreshCompletion = (value: string, caret: number): void => {
        const token = tokenAt(value, caret);
        if (!token) {
            setCompletion(undefined);
            return;
        }
        if (token.kind === 'command') {
            const commands = state?.commands ?? [];
            const needle = token.query.toLowerCase();
            const items = commands
                .filter(command => command.name.toLowerCase().startsWith(needle))
                .slice()
                .sort((left, right) => left.name.localeCompare(right.name))
                .slice(0, COMPLETION_ROWS)
                .map(command => commandItem(command));
            setCompletion({
                kind: 'command',
                start: token.start,
                query: token.query,
                items,
                selected: 0,
                hint: commands.length === 0
                    ? (agentId ? 'This agent reports no commands yet.' : 'Pick an agent first.')
                    : undefined
            });
            return;
        }
        if (token.kind === 'shell') {
            const shell = state?.capabilities?.shell === true;
            setCompletion({
                kind: 'shell',
                start: token.start,
                query: token.query,
                items: [],
                selected: 0,
                hint: shell
                    ? 'Runs in the agent\'s shell and joins the transcript. Press Enter to run it.'
                    : 'The connected agent has no shell passthrough.'
            });
            return;
        }
        // `@`: list files from the host resource service, relative to the
        // directory the agent works in.
        const directory = state?.cwd;
        if (!directory) {
            setCompletion({
                kind: 'file',
                start: token.start,
                query: token.query,
                items: [],
                selected: 0,
                hint: 'Pick an agent first.'
            });
            return;
        }
        const lookup = fileLookup.current + 1;
        fileLookup.current = lookup;
        const slash = token.query.lastIndexOf('/');
        const base = slash === -1 ? '' : token.query.slice(0, slash + 1);
        const prefix = token.query.slice(slash + 1);
        const absolute = `${directory}/${base}`.replace(/\/+$/, '') || directory;
        void resources.list(resources.fromPath(absolute))
            .then(entries => {
                if (fileLookup.current !== lookup) {
                    return;
                }
                setCompletion({
                    kind: 'file',
                    start: token.start,
                    query: token.query,
                    items: fileItems(entries, base, prefix),
                    selected: 0
                });
            })
            .catch(() => {
                if (fileLookup.current === lookup) {
                    setCompletion({
                        kind: 'file',
                        start: token.start,
                        query: token.query,
                        items: [],
                        selected: 0,
                        hint: `Cannot list ${base || directory}.`
                    });
                }
            });
    };

    /** Replaces the trigger token with the chosen completion. */
    const applyCompletion = (view: CompletionView, item: CompletionItem): void => {
        const caret = composer.current?.selectionStart ?? input.length;
        const next = `${input.slice(0, view.start)}${item.insert}${input.slice(caret)}`;
        pendingCaret.current = view.start + item.insert.length;
        setInput(next);
        // A directory keeps the menu open so the user can descend into it.
        if (item.insert.endsWith('/')) {
            refreshCompletion(next, pendingCaret.current);
        } else {
            setCompletion(undefined);
        }
    };

    const send = async (): Promise<void> => {
        const text = input.trim();
        if (!agentId || !text || busy) {
            return;
        }
        setBusy(true);
        setCompletion(undefined);
        try {
            if (text.startsWith('!')) {
                setState(await sessions.runShell(sessionId, text.slice(1)));
            } else {
                setState(await sessions.send(sessionId, text));
            }
            setInput('');
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    };

    /**
     * Stops the turn in flight.
     *
     * Deliberately not guarded by `busy`: the stop control exists for a turn that
     * is already running, which is exactly when `send` is in flight.
     */
    const stop = async (): Promise<void> => {
        setCompletion(undefined);
        try {
            setState(await sessions.interrupt(sessionId));
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const starting = state?.status === 'starting';
    const working = state?.status === 'running';
    // While a turn is in flight the button names what actually happens to the
    // message: Pi steers it into the running turn, ACP queues it for its end.
    const midTurn = state?.capabilities?.midTurn ?? 'queue';
    const sendLabel = working ? (midTurn === 'steer' ? 'Steer' : 'Queue') : 'Send';
    const sendHint = working
        ? (midTurn === 'steer'
            ? 'Delivered to the agent during its current turn.'
            : 'Held until the agent finishes the current turn.')
        : 'Send the message to the agent';
    // While a turn runs, an empty composer means the button's job changes: there
    // is nothing to send, so it becomes the stop control. Typing anything at once
    // swaps it back to Queue/Steer, because sending now means joining the turn.
    const stoppable = working && Boolean(state?.capabilities?.interrupt);
    const showStop = stoppable && input.trim().length === 0;
    const modelState = state?.model;
    const usage = state?.usage;

    // No chat header: the tab already names the agent, and the protocol is the
    // picker's business. A per-session label here would only repeat both.
    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        modelMenuOpen ? React.createElement('div', {
            style: PICKER_BACKDROP_STYLE,
            onClick: () => setModelMenuOpen(false)
        }) : undefined,
        error ? React.createElement('div', { style: ERROR_STYLE }, error) : undefined,
        React.createElement(
            'div',
            { ref: scroller, style: TRANSCRIPT_STYLE },
            agentId
                ? undefined
                : React.createElement(
                      'div',
                      { style: MUTED_STYLE },
                      'No agent in this chat yet. Use the + button to start one, or open a new tab with another agent.'
                  ),
            (state?.entries ?? []).map((entry, index) =>
                React.createElement(
                    'div',
                    { key: index, style: { ...ENTRY_STYLE, ...ROLE_STYLE[entry.role] } },
                    React.createElement('span', { style: ROLE_LABEL_STYLE }, entry.role),
                    React.createElement('span', { style: { whiteSpace: 'pre-wrap' } }, entry.text)
                )
            ),
            starting
                ? React.createElement('div', { style: MUTED_STYLE }, 'Connecting to agent...')
                : undefined,
            working
                ? React.createElement('div', { style: MUTED_STYLE }, 'Agent is working…')
                : undefined
        ),
        React.createElement(
            'div',
            { style: { position: 'relative' } },
            completion
                ? renderCompletion(React, completion, item => applyCompletion(completion, item))
                : undefined,
            React.createElement(
                'div',
                { style: COMPOSER_STYLE },
                React.createElement('textarea', {
                    ref: composer,
                    value: input,
                    placeholder: agentId
                        ? (working
                            ? (midTurn === 'steer' ? 'Steer the agent…' : 'Queue a message for after this turn…')
                            : 'Ask the agent…  /commands, @files, !shell')
                        : 'Pick an agent with + first',
                    // Height is measured from the content; `rows` would fight it.
                    rows: 1,
                    style: INPUT_STYLE,
                    disabled: !agentId,
                    onChange: (event: ReactNS.ChangeEvent<HTMLTextAreaElement>) => {
                        const value = event.target.value;
                        const caret = event.target.selectionStart ?? value.length;
                        setInput(value);
                        refreshCompletion(value, caret);
                    },
                    onKeyDown: (event: ReactNS.KeyboardEvent<HTMLTextAreaElement>) => {
                        if (completion && completion.items.length > 0) {
                            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                event.preventDefault();
                                const delta = event.key === 'ArrowDown' ? 1 : -1;
                                setCompletion({
                                    ...completion,
                                    selected: (completion.selected + delta + completion.items.length)
                                        % completion.items.length
                                });
                                return;
                            }
                            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                                event.preventDefault();
                                applyCompletion(completion, completion.items[completion.selected]);
                                return;
                            }
                        }
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void send();
                        }
                    }
                }),
                React.createElement(
                    'div',
                    { style: FOOTER_STYLE },
                    React.createElement(
                        'div',
                        { style: { display: 'flex', gap: '6px' } },
                        React.createElement(
                            'button',
                            {
                                type: 'button',
                                // One element for both jobs: the shape animates rather
                                // than a second button appearing, so the control never
                                // jumps under the pointer.
                                style: showStop ? STOP_BUTTON_STYLE : SEND_BUTTON_STYLE,
                                onClick: () => void (showStop ? stop() : send()),
                                disabled: !agentId || starting || (showStop ? false : busy),
                                title: showStop
                                    ? 'Stop the agent and discard queued messages.'
                                    : sendHint,
                                'aria-label': showStop ? 'Stop the agent' : sendLabel
                            },
                            // All three faces stay mounted and only change opacity.
                            // Swapping one out for another would pop at the exact frame
                            // the shape is mid-shrink, which is what made the morph look
                            // like two controls trading places.
                            React.createElement(
                                'span',
                                { style: LABEL_LAYERS_STYLE },
                                React.createElement(
                                    'span',
                                    { style: { ...LABEL_LAYER_STYLE, opacity: showStop || working ? 0 : 1 } },
                                    'Send'
                                ),
                                React.createElement(
                                    'span',
                                    { style: { ...LABEL_LAYER_STYLE, opacity: showStop || !working ? 0 : 1 } },
                                    midTurn === 'steer' ? 'Steer' : 'Queue'
                                ),
                                React.createElement(
                                    'span',
                                    { style: { ...GLYPH_LAYER_STYLE, opacity: showStop ? 1 : 0 } },
                                    React.createElement('span', { style: STOP_GLYPH_STYLE })
                                )
                            )
                        )
                    ),
                    React.createElement(
                        'div',
                        { style: STATUS_ROW_STYLE },
                        renderModelChip(React, modelState, () => {
                            setModelMenuOpen(open => !open);
                            setModelQuery('');
                            searchModels('');
                        }),
                        renderContextChip(React, usage),
                        renderCacheChip(React, usage)
                    )
                ),
                modelMenuOpen
                    ? renderModelMenu(React, {
                        model: modelState,
                        query: modelQuery,
                        rows: modelRows,
                        onQuery: next => {
                            setModelQuery(next);
                            searchModels(next);
                        },
                        onModel: model => void chooseModel(model),
                        onThinking: level => void chooseThinking(level),
                        filterRef: modelFilter
                    })
                    : undefined
            )
        )
    );
}

/** The agent picker behind the + button. */
function renderPicker(
    React: PanelHostTools['React'],
    installed: readonly AgentDescriptor[],
    missing: readonly AgentDescriptor[],
    pick: (agent: AgentDescriptor) => void
): ReactNS.ReactNode {
    const row = (agent: AgentDescriptor, available: boolean): ReactNS.ReactNode =>
        React.createElement(
            'button',
            {
                key: agent.id,
                type: 'button',
                style: { ...PICKER_ROW_STYLE, ...(available ? {} : PICKER_ROW_DISABLED_STYLE) },
                title: available
                    ? describeAgent(agent)
                    : `${agent.command} was not found on PATH · ${protocolLabel(agent.protocol)}`,
                disabled: !available,
                onClick: () => pick(agent)
            },
            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, agent.name),
            React.createElement('span', { style: PICKER_META_STYLE }, protocolSummary(agent))
        );

    return React.createElement(
        'div',
        { style: PICKER_STYLE },
        React.createElement('div', { style: PICKER_GROUP_STYLE }, 'Installed'),
        installed.length > 0
            ? installed.map(agent => row(agent, true))
            : React.createElement('div', { style: PICKER_EMPTY_STYLE }, 'No agent CLI installed'),
        missing.length > 0
            ? React.createElement('div', { style: PICKER_GROUP_STYLE }, 'Not installed')
            : undefined,
        missing.map(agent => row(agent, false))
    );
}

/** Model + thinking chip: the entry point of the model menu. */
function renderModelChip(
    React: PanelHostTools['React'],
    model: AgentState['model'],
    open: () => void
): ReactNS.ReactNode {
    const label = model?.current
        ? `${model.current.name}${model.thinking ? ` · ${model.thinking}` : ''}`
        : 'model —';
    const detail = model?.current
        ? [
            model.current.provider ? `provider ${model.current.provider}` : undefined,
            model.current.contextWindow ? `window ${formatTokens(model.current.contextWindow)}` : undefined,
            model.thinking ? `thinking ${model.thinking}` : undefined,
            model.modelCount ? `${model.modelCount} models available` : undefined
        ].filter(Boolean).join('\n')
        : 'No model reported yet: the agent is not running, or it does not expose model selection.';
    return React.createElement(
        'button',
        {
            type: 'button',
            style: STATUS_CHIP_STYLE,
            title: `${detail}\n\nClick to choose a model or thinking level.`,
            onClick: open
        },
        label
    );
}

/** Context window usage: percent, with the raw numbers in the tooltip. */
function renderContextChip(React: PanelHostTools['React'], usage: AgentState['usage']): ReactNS.ReactNode {
    const percent = usage?.contextPercent;
    const known = typeof percent === 'number' && Number.isFinite(percent);
    const label = known ? `ctx ${Math.round(percent)}%` : 'ctx —';
    const detail = usage?.contextTokens === null || usage?.contextTokens === undefined
        ? 'The agent reports context usage after its next reply.'
        : `${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} tokens used`;
    return React.createElement(
        'span',
        { style: STATUS_CHIP_STYLE, title: detail },
        label
    );
}

/** Cache hit share of the session's input tokens. */
function renderCacheChip(React: PanelHostTools['React'], usage: AgentState['usage']): ReactNS.ReactNode {
    const percent = usage?.cacheHitPercent;
    const known = typeof percent === 'number' && Number.isFinite(percent);
    return React.createElement(
        'span',
        {
            style: STATUS_CHIP_STYLE,
            title: 'Share of input tokens served from the provider cache (cacheRead / input + cacheRead).'
        },
        known ? `cache ${Math.round(percent)}%` : 'cache —'
    );
}

interface ModelMenuProps {
    readonly model: AgentState['model'];
    readonly query: string;
    readonly rows: readonly AgentModelInfo[];
    readonly onQuery: (query: string) => void;
    readonly onModel: (model: AgentModelInfo) => void;
    readonly onThinking: (level: string) => void;
}

/** Model and thinking picker for the connected agent. */
function renderModelMenu(
    React: PanelHostTools['React'],
    props: ModelMenuProps & { readonly filterRef: ReactNS.RefObject<HTMLInputElement | null> }
): ReactNS.ReactNode {
    const { model, query, rows, onQuery, onModel, onThinking, filterRef } = props;
    const levels = model?.thinkingLevels ?? [];
    const current = model?.current;

    return React.createElement(
        'div',
        { style: MODEL_MENU_STYLE },
        React.createElement('div', { style: PICKER_GROUP_STYLE }, 'Thinking'),
        levels.length > 0
            ? React.createElement(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '2px 6px 6px' } },
                levels.map(level => React.createElement(
                    'button',
                    {
                        key: level,
                        type: 'button',
                        style: {
                            ...THINKING_CHIP_STYLE,
                            ...(level === model?.thinking ? THINKING_CHIP_ACTIVE_STYLE : {})
                        },
                        title: `Set thinking level to ${level}`,
                        onClick: () => onThinking(level)
                    },
                    level
                ))
            )
            : React.createElement(
                'div',
                { style: PICKER_EMPTY_STYLE },
                'The connected agent reports no reasoning levels.'
            ),
        React.createElement('div', { style: PICKER_GROUP_STYLE },
            model?.modelCount ? `Model · ${model.modelCount} available` : 'Model'),
        React.createElement('input', {
            ref: filterRef,
            value: query,
            placeholder: 'Filter by name, id or provider',
            style: MODEL_FILTER_STYLE,
            onChange: (event: ReactNS.ChangeEvent<HTMLInputElement>) => onQuery(event.target.value)
        }),
        rows.length > 0
            ? rows.map(row => React.createElement(
                'button',
                {
                    key: row.key,
                    type: 'button',
                    style: { ...PICKER_ROW_STYLE, ...(row.key === current?.key ? MODEL_ROW_ACTIVE_STYLE : {}) },
                    title: [row.modelId, row.contextWindow ? `window ${formatTokens(row.contextWindow)}` : undefined]
                        .filter(Boolean).join(' · '),
                    onClick: () => onModel(row)
                },
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, row.name),
                row.provider
                    ? React.createElement('span', { style: PICKER_META_STYLE }, row.provider)
                    : undefined
            ))
            : React.createElement(
                'div',
                { style: PICKER_EMPTY_STYLE },
                model?.modelCount
                    ? 'No model matches that filter.'
                    : 'The connected agent reports no models to switch to.'
            )
    );
}

/** Composer completion popup: `/commands`, `@files`, `!shell`. */
function renderCompletion(
    React: PanelHostTools['React'],
    view: CompletionView,
    pick: (item: CompletionItem) => void
): ReactNS.ReactNode {
    return React.createElement(
        'div',
        { style: COMPLETION_STYLE },
        view.items.length > 0
            ? view.items.map((item, index) => React.createElement(
                'button',
                {
                    key: `${view.kind}-${index}`,
                    type: 'button',
                    style: { ...PICKER_ROW_STYLE, ...(index === view.selected ? MODEL_ROW_ACTIVE_STYLE : {}) },
                    onMouseDown: (event: ReactNS.MouseEvent) => {
                        // Keep the composer focused; the click still lands on this row.
                        event.preventDefault();
                    },
                    onClick: () => pick(item)
                },
                React.createElement('span', { style: { whiteSpace: 'nowrap' } }, item.label),
                item.detail
                    ? React.createElement('span', { style: PICKER_META_STYLE }, item.detail)
                    : undefined
            ))
            : React.createElement('div', { style: PICKER_EMPTY_STYLE },
                view.hint ?? (view.query ? 'No match.' : 'Keep typing.'))
    );
}

/** One `/command` row. */
function commandItem(command: AgentCommand): CompletionItem {
    return {
        insert: `/${command.name} `,
        label: `/${command.name}`,
        detail: command.source
    };
}

/** Directory-first file rows for `@`, filtered by the typed prefix. */
function fileItems(entries: readonly ResourceStat[], base: string, prefix: string): CompletionItem[] {
    const needle = prefix.toLowerCase();
    return entries
        .filter(entry => entry.name.toLowerCase().startsWith(needle))
        .sort((left, right) => {
            if (left.kind === right.kind) {
                return left.name.localeCompare(right.name);
            }
            return left.kind === 'directory' ? -1 : 1;
        })
        .slice(0, FILE_ROWS)
        .map(entry => ({
            insert: `@${base}${entry.name}${entry.kind === 'directory' ? '/' : ' '}`,
            label: `${entry.name}${entry.kind === 'directory' ? '/' : ''}`,
            detail: entry.kind === 'directory' ? 'dir' : 'file'
        }));
}

/** `200000` → `200k`, `1048576` → `1.0M`. */
function formatTokens(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '—';
    }
    if (value >= 100_000) {
        return `${Math.round(value / 1000)}k`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }
    return String(Math.round(value));
}

/** Tooltip text for one agent: how it is launched, reached, and where it came from. */
function describeAgent(agent: AgentDescriptor): string {
    const launch = agent.command ? `${agent.command} ${agent.args.join(' ')}`.trim() : 'no CLI — AG-UI only';
    const protocols = agent.agui
        ? `AG-UI at ${agent.agui}, falling back to ${protocolLabel(agent.protocol)}`
        : protocolLabel(agent.protocol);
    // Agents are plugin data, so naming the plugin says which one to disable to
    // remove this agent; an env-configured agent has no plugin to point at.
    const source = agent.pluginId ? `declared by ${agent.pluginId}` : 'set by ICEBOX_AGENTS';
    return `${launch} · ${protocols}\n${source}`;
}

/**
 * Tooltip of the agent picker's protocol column, and of the model chip.
 *
 * The protocol a session actually speaks is reported per session, not in a panel
 * header: the tab names the agent, and the picker lists what it will be tried
 * over first, so there is no separate badge to explain.
 */
const PANEL_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    height: '100%',
    overflow: 'hidden',
    background: 'var(--theia-editor-background)',
    color: 'var(--theia-editor-foreground)',
    fontFamily: 'var(--theia-ui-font-family)',
    fontSize: 'var(--theia-ui-font-size1)'
};

/** The session tabs above the chat: what is open, and what is working. */
const TAB_STRIP_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: '6px',
    // Same header box as the Git and File Browser panels (6px + a 22px control),
    // so the separator line matches when the panels are side by side.
    padding: '6px 10px',
    borderBottom: '1px solid var(--theia-panel-border)'
};

const TAB_ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexGrow: 1,
    gap: '4px',
    minWidth: 0,
    overflowX: 'auto'
};

const TAB_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    maxWidth: '220px',
    padding: '2px 2px 2px 8px',
    border: '1px solid transparent',
    borderRadius: '3px',
    cursor: 'pointer',
    opacity: 0.75
};

/** The active tab is the one whose chat is on screen. */
const TAB_ACTIVE_STYLE: ReactNS.CSSProperties = {
    border: '1px solid var(--theia-panel-border)',
    background: 'var(--theia-input-background)',
    opacity: 1
};

const TAB_LABEL_STYLE: ReactNS.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px'
};

/** A dot for a tab whose agent is mid-turn, so a hidden tab is not invisible. */
const TAB_BUSY_STYLE: ReactNS.CSSProperties = {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--theia-editorInfo-foreground, var(--theia-focusBorder))'
};

/** Closing a tab is what disconnects that session's agent. */
const TAB_CLOSE_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    padding: 0,
    border: 'none',
    borderRadius: '3px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.7
};

/**
 * Glyphs are drawn, not typed.
 *
 * A `+` or `×` character carries its own baseline and side bearings, so flex
 * centring leaves its ink slightly off-centre in a small box; bars are
 * symmetric by construction, and a rotated pair crosses exactly in the middle.
 */
const GLYPH_BOX_STYLE: ReactNS.CSSProperties = {
    position: 'relative',
    flexShrink: 0
};

const GLYPH_BAR_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    background: 'currentColor'
};

/** The + of the new-chat button: a horizontal and a vertical bar. */
function renderPlusGlyph(
    React: PanelHostTools['React'],
    size = 10,
    thickness = 1.5
): ReactNS.ReactNode {
    const offset = `${(size - thickness) / 2}px`;
    return React.createElement(
        'span',
        { style: { ...GLYPH_BOX_STYLE, width: `${size}px`, height: `${size}px` } },
        React.createElement('span', {
            style: { ...GLYPH_BAR_STYLE, left: 0, right: 0, top: offset, height: `${thickness}px` }
        }),
        React.createElement('span', {
            style: { ...GLYPH_BAR_STYLE, top: 0, bottom: 0, left: offset, width: `${thickness}px` }
        })
    );
}

/** The × of a tab's close button: two bars crossing at the box centre. */
function renderCrossGlyph(
    React: PanelHostTools['React'],
    size = 8,
    thickness = 1.25
): ReactNS.ReactNode {
    const bar: ReactNS.CSSProperties = {
        ...GLYPH_BAR_STYLE,
        left: 0,
        right: 0,
        top: `${(size - thickness) / 2}px`,
        height: `${thickness}px`
    };
    return React.createElement(
        'span',
        { style: { ...GLYPH_BOX_STYLE, width: `${size}px`, height: `${size}px` } },
        React.createElement('span', { style: { ...bar, transform: 'rotate(45deg)' } }),
        React.createElement('span', { style: { ...bar, transform: 'rotate(-45deg)' } })
    );
}

/** Contains the + picker, which positions itself against this box. */
const PICKER_ANCHOR_STYLE: ReactNS.CSSProperties = {
    position: 'relative',
    flexShrink: 0
};

/** One tab's chat. Tabs stay mounted, so a hidden one is out of flow but alive. */
const CHAT_SLOT_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0
};

const CHAT_SLOT_HIDDEN_STYLE: ReactNS.CSSProperties = {
    ...CHAT_SLOT_STYLE,
    position: 'absolute',
    inset: 0,
    visibility: 'hidden',
    pointerEvents: 'none'
};

/** The panel with no session at all: what it can do from here. */
const EMPTY_STYLE: ReactNS.CSSProperties = {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    padding: '24px',
    textAlign: 'center'
};

const EMPTY_TITLE_STYLE: ReactNS.CSSProperties = {
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '0.04em'
};

const EMPTY_TEXT_STYLE: ReactNS.CSSProperties = {
    maxWidth: '48ch',
    opacity: 0.7,
    lineHeight: 1.5
};

const EMPTY_ACTION_STYLE: ReactNS.CSSProperties = {
    padding: '5px 10px',
    border: 'none',
    borderRadius: '3px',
    background: 'var(--theia-button-secondaryBackground, var(--theia-button-background))',
    color: 'var(--theia-button-secondaryForeground, var(--theia-button-foreground))',
    font: 'inherit',
    cursor: 'pointer'
};

const EMPTY_NOTICE_STYLE: ReactNS.CSSProperties = {
    maxWidth: '48ch',
    paddingTop: '4px',
    color: 'var(--theia-descriptionForeground)',
    lineHeight: 1.5
};

const NEW_CHAT_BUTTON_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '22px',
    height: '22px',
    padding: 0,
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer'
};

const PICKER_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    top: '24px',
    right: 0,
    zIndex: 10,
    minWidth: '220px',
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

/** Model/thinking menu: anchored above the footer, scrollable. */
const MODEL_MENU_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: '10px',
    zIndex: 10,
    width: 'min(420px, calc(100% - 20px))',
    maxHeight: '60vh',
    overflowY: 'auto',
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

/** Completion popup: anchored above the composer. */
const COMPLETION_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: '10px',
    zIndex: 10,
    width: 'min(420px, calc(100% - 20px))',
    maxHeight: '40vh',
    overflowY: 'auto',
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

/** Invisible layer that closes the menus when the user clicks elsewhere. */
const PICKER_BACKDROP_STYLE: ReactNS.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 9,
    background: 'transparent'
};

const PICKER_GROUP_STYLE: ReactNS.CSSProperties = {
    padding: '4px 6px 2px',
    fontSize: '10px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    opacity: 0.6
};

const PICKER_ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    width: '100%',
    padding: '5px 8px',
    border: 'none',
    borderRadius: '3px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer'
};

const MODEL_ROW_ACTIVE_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-list-activeSelectionBackground)',
    color: 'var(--theia-list-activeSelectionForeground)'
};

const PICKER_ROW_DISABLED_STYLE: ReactNS.CSSProperties = {
    opacity: 0.4,
    cursor: 'default'
};

const PICKER_META_STYLE: ReactNS.CSSProperties = {
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    opacity: 0.7
};

const PICKER_EMPTY_STYLE: ReactNS.CSSProperties = {
    padding: '5px 8px',
    opacity: 0.65
};

const MODEL_FILTER_STYLE: ReactNS.CSSProperties = {
    margin: '0 6px 4px',
    padding: '3px 6px',
    background: 'var(--theia-input-background)',
    color: 'var(--theia-input-foreground)',
    border: '1px solid var(--theia-input-border)',
    borderRadius: '3px',
    font: 'inherit'
};

const THINKING_CHIP_STYLE: ReactNS.CSSProperties = {
    padding: '2px 8px',
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: '1px solid transparent',
    borderRadius: '10px',
    font: 'inherit',
    fontSize: '11px',
    cursor: 'pointer'
};

const THINKING_CHIP_ACTIVE_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-button-background)',
    color: 'var(--theia-button-foreground)'
};

const BUTTON_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 'inherit'
};

/**
 * The composer's one button.
 *
 * Fixed dimensions rather than padding: the stop state is the same element
 * narrowed into a circle, which needs a width to animate from and to. `overflow`
 * is hidden so the label cannot spill while the pill collapses.
 */
const SEND_BUTTON_STYLE: ReactNS.CSSProperties = {
    ...BUTTON_STYLE,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '64px',
    height: '26px',
    padding: 0,
    overflow: 'hidden',
    background: 'var(--theia-button-background)',
    color: 'var(--theia-button-foreground)',
    transition: 'width 160ms cubic-bezier(0.4, 0, 0.2, 1), border-radius 160ms cubic-bezier(0.4, 0, 0.2, 1), background-color 160ms ease'
};

/** The same button, collapsed: a red disc that interrupts the turn. */
const STOP_BUTTON_STYLE: ReactNS.CSSProperties = {
    ...SEND_BUTTON_STYLE,
    width: '26px',
    borderRadius: '50%',
    // The theme's vivid error red, not its error *surface*: `errorBackground` is a
    // darkened wash (a maroon in the dark theme) meant for alert panels, and a stop
    // control has to read as red at 26px. Both are theme variables, so a light or
    // high-contrast theme still supplies its own red.
    background: 'var(--theia-editorError-foreground, var(--theia-errorBackground))'
};

/**
 * The stop glyph's layer.
 *
 * Delayed slightly against the label fade: the square fades in once the pill has
 * started narrowing, so it reads as the button becoming a disc rather than a
 * square appearing beside the word Send.
 */
const GLYPH_LAYER_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    transition: 'opacity 110ms ease 70ms'
};

/** The stop mark: a filled square, the conventional "stop" glyph. */
const STOP_GLYPH_STYLE: ReactNS.CSSProperties = {
    // Even, against the even 26px disc: an odd mark leaves a half-pixel margin
    // on each side, and the browser snaps that half pixel to one edge, which
    // paints the square visibly off-centre in the circle. 8px keeps the mark's
    // weight and divides (26 - 8) evenly in two.
    width: '8px',
    height: '8px',
    borderRadius: '1px',
    // Cut out of the disc rather than drawn on it: a dark square on a red field is
    // the recognised stop mark, and the editor background is the surface the panel
    // actually sits on.
    background: 'var(--theia-editor-background, #ffffff)'
};

/** Both labels sit in the same box so they cross-fade instead of jumping. */
const LABEL_LAYERS_STYLE: ReactNS.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%'
};

const LABEL_LAYER_STYLE: ReactNS.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    transition: 'opacity 120ms ease'
};

const STATUS_CHIP_STYLE: ReactNS.CSSProperties = {
    padding: '2px 8px',
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '10px',
    background: 'transparent',
    color: 'var(--theia-descriptionForeground)',
    font: 'inherit',
    fontSize: '11px',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
};

/** Buttons on the left, model/usage chips on the right. */
const FOOTER_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginTop: '6px',
    flexWrap: 'wrap'
};

const STATUS_ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap'
};

const TRANSCRIPT_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    overflow: 'auto',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px'
};

const ENTRY_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-start',
    padding: '4px 6px',
    borderRadius: '4px',
    background: 'var(--theia-input-background)',
    lineHeight: 1.45
};

const ROLE_LABEL_STYLE: ReactNS.CSSProperties = {
    minWidth: '46px',
    textTransform: 'uppercase',
    fontSize: '10px',
    letterSpacing: '0.06em',
    opacity: 0.6,
    paddingTop: '2px'
};

const ROLE_STYLE: Record<string, ReactNS.CSSProperties> = {
    user: { borderLeft: '2px solid var(--theia-focusBorder)' },
    agent: { borderLeft: '2px solid var(--theia-button-background)' },
    tool: { borderLeft: '2px solid var(--theia-gitDecoration-modifiedResourceForeground)', opacity: 0.85 },
    system: { borderLeft: '2px solid var(--theia-descriptionForeground)', opacity: 0.7 }
};

const COMPOSER_STYLE: ReactNS.CSSProperties = {
    borderTop: '1px solid var(--theia-panel-border)',
    padding: '8px 10px'
};

const INPUT_STYLE: ReactNS.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'none',
    overflowY: 'hidden',
    background: 'var(--theia-input-background)',
    color: 'var(--theia-input-foreground)',
    border: '1px solid var(--theia-input-border)',
    borderRadius: '3px',
    padding: '6px',
    fontFamily: 'inherit',
    fontSize: 'inherit'
};

const MUTED_STYLE: ReactNS.CSSProperties = {
    padding: '8px 10px',
    opacity: 0.65
};

const ERROR_STYLE: ReactNS.CSSProperties = {
    padding: '6px 10px',
    color: 'var(--theia-errorForeground)',
    borderBottom: '1px solid var(--theia-panel-border)',
    whiteSpace: 'pre-wrap'
};
