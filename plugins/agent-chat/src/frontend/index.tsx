import type * as ReactNS from 'react';
import type {
    AgentChatLauncherService,
    AgentSessionHandle,
    FrontendPluginAPI,
    PanelHostTools,
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
const POLL_INTERVAL_MS = 700;
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

    // Panel ids are namespaced per plugin, so another plugin (Projects) cannot
    // open this chat through `panels.open`. It uses this launcher instead, which
    // stays owned by agent-chat and keeps the panel under this plugin's disposal.
    api.services.provide<AgentChatLauncherService>(WORKSPACE_SERVICE_IDS.agentChat, {
        openChat: options => {
            // Panel state is persisted with the layout, so it must be plain JSON:
            // absent fields are omitted rather than stored as `undefined`.
            const state: PanelState = {
                agentId: options.agentId,
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                ...(options.resume === undefined ? {} : { resume: options.resume }),
                ...(options.title === undefined ? {} : { title: options.title })
            };
            return api.panels.open(PANEL_CHAT, { state });
        }
    });

    api.panels.register({
        id: PANEL_CHAT,
        title: 'Agent Chat',
        createWidget: (instanceId, host, state) => {
            let widget: ReturnType<PanelHostTools['createReactWidget']> | undefined;
            widget = host.createReactWidget(() =>
                host.React.createElement(AgentChat, {
                    React: host.React,
                    sessions,
                    resources,
                    api,
                    instanceId,
                    initialSessionId: state?.sessionId,
                    initialAgentId: state?.agentId,
                    initialCwd: state?.cwd,
                    initialResume: state?.resume,
                    initialTitle: state?.title,
                    onAgentBound: (name: string) => {
                        if (widget) {
                            widget.title.label = name;
                        }
                    }
                })
            );
            widget.id = instanceId;
            widget.title.closable = true;
            widget.title.label = typeof state?.title === 'string' ? state.title : 'Agent Chat';
            // The agent list lives in the backend, so the tab label is refined
            // asynchronously; until then the panel keeps its generic name. A
            // caller-supplied title (a project session) wins over the agent name.
            const boundAgentId = state?.agentId;
            if (typeof boundAgentId === 'string' && typeof state?.title !== 'string') {
                void sessions.listAgents()
                    .then(list => {
                        const agent = list.find(candidate => candidate.id === boundAgentId);
                        if (agent && widget && widget.title.label === 'Agent Chat') {
                            widget.title.label = agent.name;
                        }
                    })
                    .catch(() => undefined);
            }
            return widget;
        }
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Open Agent Chat',
        execute: async () => {
            const agents = await sessions.listAgents();
            const first = availableAgents(agents)[0];
            return api.panels.open(PANEL_CHAT, first ? { state: { agentId: first.id } } : undefined);
        }
    });
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
    readonly api: FrontendPluginAPI;
    readonly instanceId: string;
    readonly initialAgentId?: unknown;
    /** Logical backend session id; defaults to the panel instance id. */
    readonly initialSessionId?: unknown;
    /** Folder the agent runs in, for a chat opened by a project list. */
    readonly initialCwd?: unknown;
    /** Agent-side handle to continue an earlier conversation. */
    readonly initialResume?: unknown;
    readonly initialTitle?: unknown;
    readonly onAgentBound: (name: string) => void;
}

/** Accepts a handle read back from panel state, ignoring malformed data. */
function isSessionHandle(value: unknown): value is AgentSessionHandle {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.agentId === 'string'
        && typeof record.sessionId === 'string'
        && (record.protocol === 'acp' || record.protocol === 'pi-rpc');
}

/** One chat session: header with a new-chat picker, transcript, composer. */
function AgentChat(props: AgentChatProps): ReactNS.ReactNode {
    const { React, sessions, api, onAgentBound, resources } = props;
    // The backend session id is the panel's own id unless a caller (Projects)
    // supplied one, so a resumed conversation keeps the same session record even
    // though the host chose a new panel instance id for the tab.
    const sessionId = typeof props.initialSessionId === 'string' ? props.initialSessionId : props.instanceId;
    const initialCwd = typeof props.initialCwd === 'string' ? props.initialCwd : undefined;
    const initialResume = isSessionHandle(props.initialResume) ? props.initialResume : undefined;
    const [agents, setAgents] = React.useState<readonly AgentDescriptor[]>([]);
    const [agentId, setAgentId] = React.useState<string | undefined>(
        typeof props.initialAgentId === 'string' ? props.initialAgentId : undefined
    );
    const [state, setState] = React.useState<AgentState>();
    const [input, setInput] = React.useState('');
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
    const [modelQuery, setModelQuery] = React.useState('');
    const [modelRows, setModelRows] = React.useState<readonly AgentModelInfo[]>([]);
    const [completion, setCompletion] = React.useState<CompletionView>();
    const scroller = React.useRef<HTMLDivElement>(null);
    const composer = React.useRef<HTMLTextAreaElement>(null);
    const modelFilter = React.useRef<HTMLInputElement>(null);
    const pendingCaret = React.useRef<number | undefined>(undefined);
    const fileLookup = React.useRef(0);

    React.useEffect(() => {
        let cancelled = false;
        // The agent list is plugin data, so it changes when a plugin is enabled or
        // disabled in the manager. Re-reading it on its own slow tick means the
        // picker follows the plugin list without reopening the tab.
        const refresh = async (): Promise<void> => {
            try {
                const list = await sessions.listAgents();
                if (!cancelled) {
                    setAgents(list);
                }
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), AGENT_LIST_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [sessions]);

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

    // The session holds a child process: release it when this panel disappears.
    React.useEffect(() => () => {
        void sessions.release(sessionId).catch(() => undefined);
    }, [sessionId, sessions]);

    // Poll the backend while the panel is mounted; there is no push channel.
    React.useEffect(() => {
        if (!agentId) {
            return;
        }
        let cancelled = false;
        const poll = async (): Promise<void> => {
            try {
                const next = await sessions.state(sessionId);
                if (!cancelled) {
                    setState(next);
                }
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
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
        if (!pickerOpen && !modelMenuOpen && !completion) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            setPickerOpen(false);
            setModelMenuOpen(false);
            setCompletion(undefined);
            composer.current?.focus();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [pickerOpen, modelMenuOpen, completion]);

    const selected = agents.find(agent => agent.id === agentId);

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

    /**
     * Opens a chat for the chosen agent.
     *
     * The + button always means "another chat": a tab that is already bound
     * opens a sibling tab, even for the same agent, so the running transcript
     * stays where it is. Only a tab with no agent yet binds in place.
     */
    const pickAgent = (agent: AgentDescriptor): void => {
        setPickerOpen(false);
        if (!agent.available) {
            return;
        }
        if (!agentId) {
            setAgentId(agent.id);
            onAgentBound(agent.name);
            return;
        }
        const newState: PanelState = {
            agentId: agent.id,
            ...(initialCwd === undefined ? {} : { cwd: initialCwd })
        };
        void api.panels.open(PANEL_CHAT, { ref: props.instanceId, mode: 'tab-after', state: newState });
    };

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
    const installed = availableAgents(agents);
    const missing = unavailableAgents(agents);
    const modelState = state?.model;
    const usage = state?.usage;
    // The protocol label reports what the session actually speaks once it is up.
    // Before that it shows what the agent will be tried over first, so the label
    // never goes blank on an idle tab.
    const protocolInUse = state?.protocol ?? (selected?.agui ? 'agui' : selected?.protocol);
    const protocolHint = describeProtocol(protocolInUse, selected, state?.aguiUnavailable);

    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement(
            'div',
            { style: HEADER_STYLE },
            React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
                React.createElement('span', { style: TITLE_STYLE }, 'Chat'),
                React.createElement(
                    'span',
                    { style: AGENT_NAME_STYLE, title: selected ? describeAgent(selected) : undefined },
                    selected ? selected.name : 'no agent'
                ),
                protocolInUse
                    ? React.createElement(
                        'span',
                        { style: PROTOCOL_BADGE_STYLE, title: protocolHint },
                        protocolLabel(protocolInUse)
                    )
                    : undefined
            ),
            React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                React.createElement(
                    'div',
                    { style: { position: 'relative' } },
                    React.createElement(
                        'button',
                        {
                            type: 'button',
                            style: NEW_CHAT_BUTTON_STYLE,
                            title: 'New chat',
                            'aria-label': 'New chat',
                            onClick: () => setPickerOpen(open => !open)
                        },
                        '+'
                    ),
                    pickerOpen ? renderPicker(React, installed, missing, pickAgent) : undefined
                )
            )
        ),
        pickerOpen
            ? React.createElement('div', {
                style: PICKER_BACKDROP_STYLE,
                onClick: () => setPickerOpen(false)
            })
            : undefined,
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
 * Tooltip of the header's protocol label.
 *
 * The label itself is short because the header is dense; the reason a chat is
 * not on AG-UI belongs here, where there is room for the endpoint and what it
 * answered. Before the session starts, "AG-UI" is the interface it will be tried
 * over first, and the native protocol is the stated fallback.
 */
function describeProtocol(
    protocol: AgentProtocol | undefined,
    agent: AgentDescriptor | undefined,
    unavailable: string | undefined
): string | undefined {
    if (!protocol) {
        return undefined;
    }
    if (protocol === 'agui') {
        return agent?.agui
            ? `This chat talks AG-UI, streaming from ${agent.agui}.`
            : 'This chat talks AG-UI.';
    }
    const native = `This chat talks ${protocolLabel(protocol)}.`;
    if (!agent?.agui) {
        return native;
    }
    if (unavailable) {
        return `${native} ${unavailable}`;
    }
    return `${native} AG-UI is tried first; ${protocolLabel(protocol)} is the fallback.`;
}

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
    justifyContent: 'space-between',
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

const AGENT_NAME_STYLE: ReactNS.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600
};

/** The wire protocol in use, next to the agent's name. */
const PROTOCOL_BADGE_STYLE: ReactNS.CSSProperties = {
    flexShrink: 0,
    padding: '1px 5px',
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '3px',
    color: 'var(--theia-descriptionForeground)',
    fontSize: '10px',
    lineHeight: '14px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap'
};

const NEW_CHAT_BUTTON_STYLE: ReactNS.CSSProperties = {
    // Flex centring instead of a line height: the glyph's own metrics would
    // otherwise sit it slightly high in a 22px box.
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '22px',
    height: '22px',
    padding: 0,
    lineHeight: '1',
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '15px'
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
    // The theme's error colour, so the stop reads as destructive in every theme
    // instead of hardcoding a red.
    background: 'var(--theia-errorBackground)'
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
    width: '9px',
    height: '9px',
    borderRadius: '1px',
    background: 'currentColor'
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
