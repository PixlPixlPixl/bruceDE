import type { FrontendPluginAPI, PanelHostTools, PluginDisposer } from '@brucede/plugin-api';

const COMMAND_OPEN = 'bruce.terminal.open';
const PANEL_TERMINAL = 'terminal.main';

/**
 * Native renderer entrypoint for terminal.
 *
 * This is a scaffold: it registers the real panel type and the command that
 * opens it so the runtime contract (registration, docking, disposal) is
 * exercised end-to-end. The terminal emulator itself is the next step.
 */
export function activate(api: FrontendPluginAPI): PluginDisposer {
    api.panels.register({
        id: PANEL_TERMINAL,
        title: 'Terminal',
        createWidget: (instanceId, host) => createTerminalWidget(host, instanceId)
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Terminal: New Terminal',
        execute: () => api.panels.open(PANEL_TERMINAL)
    });

    // Returning a disposer is optional; the host also disposes everything the
    // API registered above when the plugin unloads.
    return () => undefined;
}

function createTerminalWidget(host: PanelHostTools, instanceId: string) {
    const React = host.React;
    const widget = host.createReactWidget(() =>
        React.createElement(
            'div',
            { className: 'bruce-terminal-scaffold' },
            React.createElement('div', { className: 'bruce-terminal-header' }, `Terminal ${instanceId}`),
            React.createElement(
                'pre',
                { className: 'bruce-terminal-body' },
                '$ pwd\n/home/user/project\n\n$ pi\nBruceDE terminal plugin is loaded; the shell backend is not wired yet.'
            )
        )
    );
    widget.title.label = 'Terminal';
    widget.title.closable = true;
    return widget;
}
