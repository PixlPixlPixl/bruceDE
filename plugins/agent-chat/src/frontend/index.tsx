import type * as ReactNS from 'react';
import type { FrontendPluginAPI, PanelHostTools, PanelState } from '@brucede/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import type { AgentDescriptor, AgentSessionsService, AgentState } from '../shared.js';

const PANEL_CHAT = 'agent-chat.conversation';
const COMMAND_OPEN = 'bruce.agent-chat.open';
const POLL_INTERVAL_MS = 700;

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

    api.panels.register({
        id: PANEL_CHAT,
        title: 'Agent Chat',
        createWidget: (instanceId, host, state) => {
            let widget: ReturnType<PanelHostTools['createReactWidget']> | undefined;
            widget = host.createReactWidget(() =>
                host.React.createElement(AgentChat, {
                    React: host.React,
                    sessions,
                    api,
                    instanceId,
                    initialAgentId: state?.agentId,
                    onAgentBound: (name: string) => {
                        if (widget) {
                            widget.title.label = name;
                        }
                    }
                })
            );
            widget.id = instanceId;
            widget.title.closable = true;
            widget.title.label = 'Agent Chat';
            // The agent list lives in the backend, so the tab label is refined
            // asynchronously; until then the panel keeps its generic name.
            const boundAgentId = state?.agentId;
            if (typeof boundAgentId === 'string') {
                void sessions.listAgents()
                    .then(list => {
                        const agent = list.find(candidate => candidate.id === boundAgentId);
                        if (agent && widget) {
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
        title: 'Agent: Open Chat',
        execute: async () => {
            const agents = await sessions.listAgents();
            const first = availableAgents(agents)[0];
            return api.panels.open(PANEL_CHAT, first ? { state: { agentId: first.id } } : undefined);
        }
    });
}

/** Human name of the wire protocol, shown next to an agent in the picker. */
function protocolLabel(protocol: AgentDescriptor['protocol']): string {
    return protocol === 'pi-rpc' ? 'Pi RPC' : 'ACP';
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

interface AgentChatProps {
    readonly React: PanelHostTools['React'];
    readonly sessions: AgentSessionsService;
    readonly api: FrontendPluginAPI;
    readonly instanceId: string;
    readonly initialAgentId?: unknown;
    readonly onAgentBound: (name: string) => void;
}

/** One chat session: header with a new-chat picker, transcript, composer. */
function AgentChat(props: AgentChatProps): ReactNS.ReactNode {
    const { React, sessions, api, instanceId, onAgentBound } = props;
    const [agents, setAgents] = React.useState<readonly AgentDescriptor[]>([]);
    const [agentId, setAgentId] = React.useState<string | undefined>(
        typeof props.initialAgentId === 'string' ? props.initialAgentId : undefined
    );
    const [state, setState] = React.useState<AgentState>();
    const [input, setInput] = React.useState('');
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const scroller = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
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
        })();
        return () => {
            cancelled = true;
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
                const next = await sessions.openSession(instanceId, agentId);
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
    }, [agentId, instanceId, sessions]);

    // The session holds a child process: release it when this panel disappears.
    React.useEffect(() => () => {
        void sessions.release(instanceId).catch(() => undefined);
    }, [instanceId, sessions]);

    // Poll the backend while the panel is mounted; there is no push channel.
    React.useEffect(() => {
        if (!agentId) {
            return;
        }
        let cancelled = false;
        const poll = async (): Promise<void> => {
            try {
                const next = await sessions.state(instanceId);
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
    }, [agentId, instanceId, sessions]);

    // Keep the newest entry in view.
    React.useEffect(() => {
        const element = scroller.current;
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, [state?.entries.length, state?.status]);

    // Escape closes the picker. Outside clicks are handled by the backdrop below:
    // a document-level listener would dismiss on `mousedown`, before the `click`
    // could land on the row the user aimed at.
    React.useEffect(() => {
        if (!pickerOpen) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setPickerOpen(false);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [pickerOpen]);

    const selected = agents.find(agent => agent.id === agentId);

    /**
     * Opens a chat for the chosen agent.
     *
     * A panel that has no agent yet binds the choice in place; a panel that is
     * already chatting opens a *new* tab next to itself, so the running session
     * keeps its transcript and its agent process.
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
        if (agent.id === agentId) {
            return;
        }
        const newState: PanelState = { agentId: agent.id };
        void api.panels.open(PANEL_CHAT, { ref: instanceId, mode: 'tab-after', state: newState });
    };

    const send = async (): Promise<void> => {
        const text = input.trim();
        if (!agentId || !text || busy) {
            return;
        }
        setBusy(true);
        try {
            setState(await sessions.send(instanceId, text));
            setInput('');
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    };

    const cancel = async (): Promise<void> => {
        if (!agentId) {
            return;
        }
        try {
            setState(await sessions.cancel(instanceId));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const reset = async (): Promise<void> => {
        if (!agentId) {
            return;
        }
        try {
            setState(await sessions.reset(instanceId));
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const running = state?.status === 'running' || state?.status === 'starting';
    const installed = availableAgents(agents);
    const missing = unavailableAgents(agents);

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
                )
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
                            title: 'New chat with another agent',
                            'aria-label': 'New chat',
                            onClick: () => setPickerOpen(open => !open)
                        },
                        '+'
                    ),
                    pickerOpen ? renderPicker(React, installed, missing, pickAgent) : undefined
                ),
                React.createElement(
                    'button',
                    { type: 'button', style: BUTTON_STYLE, onClick: () => void reset(), disabled: !agentId },
                    'Reset'
                )
            )
        ),
        pickerOpen
            ? React.createElement('div', {
                style: PICKER_BACKDROP_STYLE,
                onClick: () => setPickerOpen(false)
            })
            : undefined,
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
            running
                ? React.createElement('div', { style: MUTED_STYLE }, 'Agent is working…')
                : undefined
        ),
        React.createElement(
            'div',
            { style: COMPOSER_STYLE },
            React.createElement('textarea', {
                value: input,
                placeholder: agentId ? 'Ask the agent…' : 'Pick an agent with + first',
                rows: 3,
                style: INPUT_STYLE,
                disabled: !agentId,
                onChange: (event: ReactNS.ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value),
                onKeyDown: (event: ReactNS.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                    }
                }
            }),
            React.createElement(
                'div',
                { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        style: PRIMARY_BUTTON_STYLE,
                        onClick: () => void send(),
                        disabled: !agentId || busy
                    },
                    'Send'
                ),
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        style: BUTTON_STYLE,
                        onClick: () => void cancel(),
                        disabled: !running
                    },
                    'Cancel'
                )
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
            React.createElement('span', { style: PICKER_META_STYLE }, protocolLabel(agent.protocol))
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

/** Tooltip text for one agent: its launch command and protocol. */
function describeAgent(agent: AgentDescriptor): string {
    return `${agent.command} ${agent.args.join(' ')} · ${protocolLabel(agent.protocol)}`;
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

const NEW_CHAT_BUTTON_STYLE: ReactNS.CSSProperties = {
    width: '22px',
    height: '22px',
    lineHeight: '18px',
    padding: 0,
    textAlign: 'center',
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '14px'
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

/** Invisible layer that closes the picker when the user clicks elsewhere. */
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

const BUTTON_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 'inherit'
};

const PRIMARY_BUTTON_STYLE: ReactNS.CSSProperties = {
    ...BUTTON_STYLE,
    background: 'var(--theia-button-background)',
    color: 'var(--theia-button-foreground)',
    padding: '4px 14px'
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
    resize: 'vertical',
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
