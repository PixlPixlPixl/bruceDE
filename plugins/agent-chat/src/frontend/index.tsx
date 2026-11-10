import type { FrontendPluginAPI, PanelHostTools, PluginDisposer } from '@brucede/plugin-api';

const COMMAND_OPEN = 'bruce.agent-chat.open';
const PANEL_CONVERSATION = 'agent-chat.conversation';

/**
 * Native renderer entrypoint for agent chat.
 *
 * Scaffold: registers the conversation panel and its open command. The agent
 * session backend will be added to this plugin's backend module.
 */
export function activate(api: FrontendPluginAPI): PluginDisposer {
    api.panels.register({
        id: PANEL_CONVERSATION,
        title: 'Agent Chat',
        createWidget: (_instanceId, host) => createChatWidget(host)
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Agent: Open Chat',
        execute: () => api.panels.open(PANEL_CONVERSATION)
    });

    return () => undefined;
}

function createChatWidget(host: PanelHostTools) {
    const React = host.React;
    const widget = host.createReactWidget(() =>
        React.createElement(
            'div',
            { className: 'bruce-agent-scaffold' },
            React.createElement('div', { className: 'bruce-agent-header' }, 'Agent Chat'),
            React.createElement(
                'div',
                { className: 'bruce-agent-messages' },
                React.createElement('div', { className: 'bruce-agent-message agent' }, 'Agent session is not connected yet.'),
                React.createElement('div', { className: 'bruce-agent-message hint' }, 'This panel is loaded by the BruceDE plugin runtime.')
            )
        )
    );
    widget.title.label = 'Agent Chat';
    widget.title.closable = true;
    return widget;
}
