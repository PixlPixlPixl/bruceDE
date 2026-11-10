import type * as ReactNS from 'react';
import type { FrontendPluginAPI, PanelHostTools } from '@brucede/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import type { AgentDescriptor, AgentSessionsService, AgentState } from '../shared.js';

const PANEL_CHAT = 'agent-chat.conversation';
const COMMAND_OPEN = 'bruce.agent-chat.open';
const POLL_INTERVAL_MS = 700;

/**
 * Native renderer entrypoint for agent chat.
 *
 * The agent runs in the backend half as an ACP child process. Streaming updates
 * cannot be pushed across the RPC boundary, so this panel polls the backend
 * service while a turn is open and after every send.
 */
export function activate(api: FrontendPluginAPI): void {
    const sessions = api.services.remote<AgentSessionsService>(WORKSPACE_SERVICE_IDS.agentSessions);

    api.panels.register({
        id: PANEL_CHAT,
        title: 'Agent Chat',
        createWidget: (instanceId, host) => {
            const widget = host.createReactWidget(() =>
                host.React.createElement(AgentChat, { React: host.React, sessions })
            );
            widget.title.label = 'Agent Chat';
            widget.title.closable = true;
            widget.id = instanceId;
            return widget;
        }
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Agent: Open Chat',
        execute: () => api.panels.open(PANEL_CHAT)
    });
}

/** Human name of the wire protocol, shown in the agent picker tooltip. */
function protocolLabel(protocol: AgentDescriptor['protocol']): string {
    return protocol === 'pi-rpc' ? 'Pi RPC' : 'ACP';
}

interface AgentChatProps {
    readonly React: PanelHostTools['React'];
    readonly sessions: AgentSessionsService;
}

/** Agent picker, transcript and composer. */
function AgentChat(props: AgentChatProps): ReactNS.ReactNode {
    const { React, sessions } = props;
    const [agents, setAgents] = React.useState<readonly AgentDescriptor[]>([]);
    const [agentId, setAgentId] = React.useState<string>();
    const [state, setState] = React.useState<AgentState>();
    const [input, setInput] = React.useState('');
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const scroller = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const list = await sessions.listAgents();
                if (cancelled) {
                    return;
                }
                setAgents(list);
                const first = list.find(agent => agent.available) ?? list[0];
                if (first) {
                    setAgentId(first.id);
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

    // Poll the backend while the panel is mounted; there is no push channel.
    React.useEffect(() => {
        if (!agentId) {
            return;
        }
        let cancelled = false;
        const poll = async (): Promise<void> => {
            try {
                const next = await sessions.state(agentId);
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
    }, [agentId, sessions]);

    React.useEffect(() => {
        const element = scroller.current;
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, [state?.entries.length, state?.status]);

    const selected = agents.find(agent => agent.id === agentId);

    const send = async (): Promise<void> => {
        const text = input.trim();
        if (!agentId || !text || busy) {
            return;
        }
        setBusy(true);
        try {
            setState(await sessions.send(agentId, text));
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
            setState(await sessions.cancel(agentId));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const reset = async (): Promise<void> => {
        if (!agentId) {
            return;
        }
        try {
            setState(await sessions.reset(agentId));
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const running = state?.status === 'running' || state?.status === 'starting';

    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement(
            'div',
            { style: HEADER_STYLE },
            React.createElement('span', { style: TITLE_STYLE }, 'Agent'),
            React.createElement(
                'div',
                { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                agents.map(agent =>
                    React.createElement(
                        'button',
                        {
                            key: agent.id,
                            type: 'button',
                            title: agent.available
                                ? `${agent.command} ${agent.args.join(' ')} · ${protocolLabel(agent.protocol)}`
                                : `${agent.command} was not found on PATH (${protocolLabel(agent.protocol)})`,
                            style: {
                                ...BUTTON_STYLE,
                                opacity: agent.available ? 1 : 0.45,
                                ...(agent.id === agentId ? ACTIVE_BUTTON_STYLE : {})
                            },
                            onClick: () => {
                                setState(undefined);
                                setError(undefined);
                                setAgentId(agent.id);
                            }
                        },
                        agent.name
                    )
                ),
                React.createElement(
                    'button',
                    { type: 'button', style: BUTTON_STYLE, onClick: () => void reset(), disabled: !agentId },
                    'Reset'
                )
            )
        ),
        agents.length === 0
            ? React.createElement(
                  'div',
                  { style: MUTED_STYLE },
                  'No agent CLI found. Install Pi (npm install -g @earendil-works/pi-coding-agent) '
                      + 'or an ACP agent such as Gemini CLI, or set BRUCEDE_AGENTS to a JSON array of '
                      + '{ id, name, protocol?, command, args? } entries, then reopen this panel.'
              )
            : undefined,
        selected && !selected.available
            ? React.createElement(
                  'div',
                  { style: MUTED_STYLE },
                  `"${selected.command}" was not found on PATH. Install it or point BRUCEDE_AGENTS at it.`
              )
            : undefined,
        error ? React.createElement('div', { style: ERROR_STYLE }, error) : undefined,
        React.createElement(
            'div',
            { ref: scroller, style: TRANSCRIPT_STYLE },
            (state?.entries ?? []).map((entry, index) =>
                React.createElement(
                    'div',
                    { key: index, style: { ...ENTRY_STYLE, ...ROLE_STYLE[entry.role] } },
                    React.createElement('span', { style: ROLE_LABEL_STYLE }, entry.role),
                    React.createElement('span', { style: { whiteSpace: 'pre-wrap' } }, entry.text)
                )
            ),
            state?.status === 'running'
                ? React.createElement('div', { style: MUTED_STYLE }, 'Agent is working…')
                : undefined
        ),
        React.createElement(
            'div',
            { style: COMPOSER_STYLE },
            React.createElement('textarea', {
                value: input,
                placeholder: agentId ? 'Ask the agent…' : 'Select an agent first',
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
                        disabled: !agentId || running || busy || !input.trim()
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

const BUTTON_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 'inherit'
};

const ACTIVE_BUTTON_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-button-background)',
    color: 'var(--theia-button-foreground)'
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
