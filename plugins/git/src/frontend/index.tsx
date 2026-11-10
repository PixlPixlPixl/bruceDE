import type { FrontendPluginAPI, PanelHostTools, PluginDisposer } from '@brucede/plugin-api';

const COMMAND_OPEN = 'bruce.git.open';
const PANEL_CHANGES = 'git.changes';

const DEMO_CHANGES = [
    { status: 'M', path: 'package.json' },
    { status: 'M', path: 'workspace-core/src/index.ts' },
    { status: 'A', path: 'plugins/git/src/frontend/index.tsx' }
];

/**
 * Native renderer entrypoint for git.
 *
 * Scaffold: registers the Git panel and its open command. Repository status
 * will be provided by the plugin's backend module through `api.services`.
 */
export function activate(api: FrontendPluginAPI): PluginDisposer {
    api.panels.register({
        id: PANEL_CHANGES,
        title: 'Git',
        createWidget: (_instanceId, host) => createGitWidget(host)
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Git: Open Changes',
        execute: () => api.panels.open(PANEL_CHANGES)
    });

    return () => undefined;
}

function createGitWidget(host: PanelHostTools) {
    const React = host.React;
    const widget = host.createReactWidget(() =>
        React.createElement(
            'div',
            { className: 'bruce-git-scaffold' },
            React.createElement('div', { className: 'bruce-git-header' }, 'Changes'),
            React.createElement(
                'ul',
                { className: 'bruce-git-list' },
                DEMO_CHANGES.map(change =>
                    React.createElement(
                        'li',
                        { key: change.path, className: 'bruce-git-item' },
                        React.createElement('span', { className: 'bruce-git-status' }, change.status),
                        ' ',
                        change.path
                    )
                )
            )
        )
    );
    widget.title.label = 'Git';
    widget.title.closable = true;
    return widget;
}
