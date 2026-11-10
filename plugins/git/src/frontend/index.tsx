import type * as ReactNS from 'react';
import type {
    FrontendPluginAPI,
    PanelHostTools,
    WorkspaceResourcesService,
    WorkspaceSelectionService
} from '@brucede/plugin-api';
import { WORKSPACE_EVENT_IDS, WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import type { GitChange, GitRepositoryService, GitStatus } from '../shared.js';

const PANEL_GIT = 'git.changes';
const COMMAND_OPEN = 'bruce.git.open';

/**
 * Native renderer entrypoint for the Git panel.
 *
 * The renderer has no process access, so it calls the backend plugin's service
 * over the host's service bridge (`api.services.remote`). Nothing is imported
 * from the backend half except wire types.
 */
export function activate(api: FrontendPluginAPI): void {
    const repository = api.services.remote<GitRepositoryService>(WORKSPACE_SERVICE_IDS.gitRepository);
    const selection = api.services.has(WORKSPACE_SERVICE_IDS.selection)
        ? api.services.get<WorkspaceSelectionService>(WORKSPACE_SERVICE_IDS.selection)
        : undefined;
    const resources = api.services.get<WorkspaceResourcesService>(WORKSPACE_SERVICE_IDS.resources);

    api.panels.register({
        id: PANEL_GIT,
        title: 'Git',
        createWidget: (instanceId, host) => {
            const widget = host.createReactWidget(() =>
                host.React.createElement(GitPanel, {
                    React: host.React,
                    repository,
                    resources,
                    selection,
                    api
                })
            );
            widget.title.label = 'Git';
            widget.title.closable = true;
            widget.id = instanceId;
            return widget;
        }
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Git: Open Changes',
        execute: () => api.panels.open(PANEL_GIT)
    });
}

interface GitPanelProps {
    readonly React: PanelHostTools['React'];
    readonly repository: GitRepositoryService;
    readonly resources: WorkspaceResourcesService;
    readonly selection?: WorkspaceSelectionService;
    readonly api: FrontendPluginAPI;
}

/** Branch summary plus the staged/unstaged/untracked change list. */
function GitPanel(props: GitPanelProps): ReactNS.ReactNode {
    const { React, repository, resources, selection, api } = props;
    const [status, setStatus] = React.useState<GitStatus>();
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);

    const refresh = React.useCallback(() => {
        setBusy(true);
        void (async () => {
            try {
                const next = await repository.status();
                setStatus(next);
                setError(next.error);
                // Notify other renderer plugins; the backend cannot push events
                // across the RPC boundary, so the panel republishes on refresh.
                api.events.emit(WORKSPACE_EVENT_IDS.changesUpdated, next);
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                setBusy(false);
            }
        })();
    }, [api.events, repository]);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    const open = (change: GitChange): void => {
        if (!selection) {
            return;
        }
        // Paths are relative to the repository root; the host service owns URI
        // construction so the File Browser and this panel agree on identity.
        const root = status?.root;
        const absolute = change.path.startsWith('/') ? change.path : `${root ?? ''}/${change.path}`;
        selection.set({
            uri: resources.fromPath(absolute),
            ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }]
        });
    };

    const staged = (status?.changes ?? []).filter(change => change.staged);
    const unstaged = (status?.changes ?? []).filter(change => !change.staged && !change.untracked);
    const untracked = (status?.changes ?? []).filter(change => change.untracked);

    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement(
            'div',
            { style: HEADER_STYLE },
            React.createElement(
                'span',
                { style: TITLE_STYLE },
                status?.repository
                    ? `${status.branch ?? 'detached'}${aheadBehind(status)}`
                    : 'Git'
            ),
            React.createElement(
                'button',
                { type: 'button', style: BUTTON_STYLE, onClick: refresh, disabled: busy },
                busy ? '…' : 'Refresh'
            )
        ),
        React.createElement(
            'div',
            { style: LIST_STYLE },
            error ? React.createElement('div', { style: MUTED_STYLE }, error) : undefined,
            status && !status.repository && !error
                ? React.createElement('div', { style: MUTED_STYLE }, 'Not a git repository.')
                : undefined,
            status?.repository && status.changes.length === 0
                ? React.createElement('div', { style: MUTED_STYLE }, 'No changes.')
                : undefined,
            section(React, 'Staged', staged, open, 'staged'),
            section(React, 'Changes', unstaged, open, 'unstaged'),
            section(React, 'Untracked', untracked, open, 'untracked')
        )
    );
}

function section(
    React: PanelHostTools['React'],
    title: string,
    changes: readonly GitChange[],
    open: (change: GitChange) => void,
    tone: 'staged' | 'unstaged' | 'untracked'
): ReactNS.ReactNode {
    if (changes.length === 0) {
        return undefined;
    }
    return React.createElement(
        'div',
        { key: tone, style: { marginBottom: '8px' } },
        React.createElement('div', { style: TITLE_STYLE }, `${title} (${changes.length})`),
        changes.map(change =>
            React.createElement(
                'button',
                {
                    key: `${tone}:${change.path}`,
                    type: 'button',
                    style: ROW_STYLE,
                    title: change.path,
                    onClick: () => open(change)
                },
                React.createElement('span', { style: BADGE_STYLE }, badge(change)),
                React.createElement('span', { style: { ...PATH_STYLE, color: toneColor(tone) } }, change.path)
            )
        )
    );
}

function aheadBehind(status: GitStatus): string {
    const parts: string[] = [];
    if (status.ahead > 0) {
        parts.push(`↑${status.ahead}`);
    }
    if (status.behind > 0) {
        parts.push(`↓${status.behind}`);
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function badge(change: GitChange): string {
    if (change.untracked) {
        return '?';
    }
    const index = change.indexStatus === '.' ? '' : change.indexStatus;
    const workTree = change.workTreeStatus === '.' ? '' : change.workTreeStatus;
    return `${index}${workTree || ''}`.trim() || '·';
}

function toneColor(tone: 'staged' | 'unstaged' | 'untracked'): string {
    if (tone === 'staged') {
        return 'var(--theia-gitDecoration-addedResourceForeground)';
    }
    if (tone === 'unstaged') {
        return 'var(--theia-gitDecoration-modifiedResourceForeground)';
    }
    return 'var(--theia-descriptionForeground)';
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
    opacity: 0.7,
    padding: '6px 10px 2px'
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

const LIST_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    overflow: 'auto',
    padding: '0 0 8px'
};

const MUTED_STYLE: ReactNS.CSSProperties = {
    padding: '10px',
    opacity: 0.65
};

const ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    gap: '8px',
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    padding: '2px 10px',
    fontFamily: 'var(--theia-code-font-family)',
    fontSize: 'inherit',
    cursor: 'pointer'
};

const BADGE_STYLE: ReactNS.CSSProperties = {
    minWidth: '18px',
    opacity: 0.8
};

const PATH_STYLE: ReactNS.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};
