import type { FrontendPluginAPI, PanelHostTools, PluginDisposer } from '@brucede/plugin-api';

const COMMAND_OPEN = 'bruce.file-browser.open';
const PANEL_FILES = 'files.browser';

const DEMO_FILES = [
    'AGENTS.md',
    'README.md',
    'package.json',
    'workspace-core/',
    'packages/',
    'plugins/'
];

/**
 * Native renderer entrypoint for file browser.
 *
 * Scaffold: registers the Files panel and its open command through the plugin
 * runtime. Real filesystem listing will move to the plugin's backend module.
 */
export function activate(api: FrontendPluginAPI): PluginDisposer {
    api.panels.register({
        id: PANEL_FILES,
        title: 'Files',
        createWidget: (_instanceId, host) => createFilesWidget(host)
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Files: Open File Browser',
        execute: () => api.panels.open(PANEL_FILES)
    });

    return () => undefined;
}

function createFilesWidget(host: PanelHostTools) {
    const React = host.React;
    const widget = host.createReactWidget(() =>
        React.createElement(
            'div',
            { className: 'bruce-files-scaffold' },
            React.createElement('div', { className: 'bruce-files-header' }, 'Workspace'),
            React.createElement(
                'ul',
                { className: 'bruce-files-list' },
                DEMO_FILES.map(name =>
                    React.createElement('li', { key: name, className: 'bruce-files-item' }, name)
                )
            )
        )
    );
    widget.title.label = 'Files';
    widget.title.closable = true;
    return widget;
}
