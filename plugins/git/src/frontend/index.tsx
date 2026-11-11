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
                'div',
                { style: HEADER_TEXT_STYLE },
                React.createElement(
                    'span',
                    { style: BRANCH_STYLE },
                    status?.repository ? (status.branch ?? 'detached HEAD') : 'Git'
                ),
                status?.repository && (status.ahead > 0 || status.behind > 0)
                    ? React.createElement('span', { style: MUTED_INLINE_STYLE }, aheadBehind(status))
                    : undefined,
                status?.root
                    ? React.createElement('span', { style: ROOT_STYLE, title: status.root }, baseName(status.root))
                    : undefined
            ),
            React.createElement(
                'button',
                {
                    type: 'button',
                    style: ICON_BUTTON_STYLE,
                    title: 'Refresh the change list',
                    'aria-label': 'Refresh',
                    onClick: refresh,
                    disabled: busy
                },
                // Icon from the codicon font the shell already loads.
                React.createElement('i', {
                    className: busy ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-refresh',
                    'aria-hidden': true
                })
            )
        ),
        React.createElement(
            'div',
            { style: LIST_STYLE },
            error ? React.createElement('div', { style: MESSAGE_STYLE }, error) : undefined,
            status && !status.repository && !error
                ? React.createElement('div', { style: MESSAGE_STYLE }, 'Not a git repository.')
                : undefined,
            status?.repository && status.changes.length === 0
                ? React.createElement('div', { style: MESSAGE_STYLE }, 'Working tree clean.')
                : undefined,
            section(React, 'Staged', staged, open),
            section(React, 'Changes', unstaged, open),
            section(React, 'Untracked', untracked, open)
        )
    );
}

function section(
    React: PanelHostTools['React'],
    title: string,
    changes: readonly GitChange[],
    open: (change: GitChange) => void
): ReactNS.ReactNode {
    if (changes.length === 0) {
        return undefined;
    }
    const added = changes.reduce((total, change) => total + (change.added ?? 0), 0);
    const deleted = changes.reduce((total, change) => total + (change.deleted ?? 0), 0);
    return React.createElement(
        'div',
        { key: title },
        React.createElement(
            'div',
            { style: SECTION_STYLE },
            React.createElement('span', undefined, `${title} · ${changes.length}`),
            added > 0 || deleted > 0
                ? React.createElement(
                      'span',
                      { style: SUMMARY_COUNTS_STYLE },
                      added > 0 ? React.createElement('span', { style: ADDED_STYLE }, `+${added}`) : undefined,
                      deleted > 0 ? React.createElement('span', { style: DELETED_STYLE }, `-${deleted}`) : undefined
                  )
                : undefined
        ),
        changes.map(change => renderChange(React, change, open))
    );
}

/** One file: status letter, path, then its own +/- line counts. */
function renderChange(
    React: PanelHostTools['React'],
    change: GitChange,
    open: (change: GitChange) => void
): ReactNS.ReactNode {
    const kind = kindOf(change);
    const accent = KIND_COLOR[kind];
    const added = change.added ?? 0;
    const deleted = change.deleted ?? 0;
    return React.createElement(
        'button',
        {
            key: change.path,
            type: 'button',
            style: ROW_STYLE,
            title: `${change.path}${added || deleted ? `  +${added} -${deleted}` : ''}`,
            onClick: () => open(change)
        },
        React.createElement('span', { style: { ...BADGE_STYLE, color: accent } }, badge(change)),
        React.createElement('span', { style: { ...PATH_STYLE, color: accent } }, change.path),
        added > 0 ? React.createElement('span', { style: ADDED_STYLE }, `+${added}`) : undefined,
        deleted > 0 ? React.createElement('span', { style: DELETED_STYLE }, `-${deleted}`) : undefined
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
    return parts.join(' ');
}

function badge(change: GitChange): string {
    if (change.untracked) {
        return '?';
    }
    const letters = `${change.indexStatus}${change.workTreeStatus}`.replace(/\./g, '').trim();
    return letters.length > 0 ? letters : '·';
}

/** What the change means, which decides its colour. */
type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict' | 'untracked' | 'other';

/**
 * Port/status hybrid → one kind.
 *
 * Precedence follows what the user needs to notice first: a conflict is louder
 * than a deletion, a deletion louder than an addition (a staged addition that is
 * gone from the work tree is a deletion now), and a plain edit is the quietest.
 */
function kindOf(change: GitChange): ChangeKind {
    if (change.untracked) {
        return 'untracked';
    }
    const index = change.indexStatus;
    const workTree = change.workTreeStatus;
    const letters = `${index}${workTree}`;
    if (letters.includes('U')) {
        return 'conflict';
    }
    if (letters.includes('D')) {
        return 'deleted';
    }
    if (letters.includes('A')) {
        return 'added';
    }
    if (letters.includes('R') || letters.includes('C')) {
        return 'renamed';
    }
    if (letters.includes('M') || letters.includes('T')) {
        return 'modified';
    }
    return 'other';
}

function baseName(root: string): string {
    const trimmed = root.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/**
 * Per-kind colour.
 *
 * The `--theia-gitDecoration-*` tokens exist only when a Git extension
 * contributes them, which this build does not have, so every use carries the
 * fallback from the dark theme it would otherwise inherit.
 */
const KIND_COLOR: Record<ChangeKind, string> = {
    added: 'var(--theia-gitDecoration-addedResourceForeground, #81b88b)',
    untracked: 'var(--theia-gitDecoration-untrackedResourceForeground, #73c991)',
    modified: 'var(--theia-gitDecoration-modifiedResourceForeground, #e2c08d)',
    deleted: 'var(--theia-gitDecoration-deletedResourceForeground, #c74e39)',
    renamed: 'var(--theia-gitDecoration-renamedResourceForeground, #73c991)',
    conflict: 'var(--theia-gitDecoration-conflictingResourceForeground, #e4676b)',
    other: 'var(--theia-descriptionForeground)'
};

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
    padding: '10px 14px',
    borderBottom: '1px solid var(--theia-panel-border)'
};

const HEADER_TEXT_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    minWidth: 0
};

const BRANCH_STYLE: ReactNS.CSSProperties = {
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

const MUTED_INLINE_STYLE: ReactNS.CSSProperties = {
    color: 'var(--theia-descriptionForeground)',
    fontSize: '11px'
};

const ROOT_STYLE: ReactNS.CSSProperties = {
    color: 'var(--theia-descriptionForeground)',
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

/** Square, icon-only button that lines up with the header text. */
const ICON_BUTTON_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    padding: 0,
    flexShrink: 0,
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '14px'
};

const LIST_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    overflowY: 'auto',
    padding: '6px 0 10px'
};

/** Section heading: name and count on the left, its own diff total on the right. */
const SECTION_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    padding: '10px 14px 4px',
    color: 'var(--theia-descriptionForeground)',
    fontSize: '10px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase'
};

const SUMMARY_COUNTS_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    gap: '6px',
    fontVariantNumeric: 'tabular-nums'
};

/**
 * A file row.
 *
 * `color: inherit` matters: a bare `<button>` otherwise paints its label with the
 * browser's default button text colour, which is black and unreadable on the
 * dark editor background.
 */
const ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '3px 14px',
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    fontFamily: 'var(--theia-code-font-family)',
    fontSize: 'inherit',
    textAlign: 'left',
    lineHeight: 1.5,
    cursor: 'pointer'
};

const BADGE_STYLE: ReactNS.CSSProperties = {
    minWidth: '16px',
    fontWeight: 600,
    fontSize: '11px',
    textAlign: 'center'
};

const PATH_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
};

const ADDED_STYLE: ReactNS.CSSProperties = {
    color: 'var(--theia-gitDecoration-addedResourceForeground, #81b88b)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums'
};

const DELETED_STYLE: ReactNS.CSSProperties = {
    color: 'var(--theia-gitDecoration-deletedResourceForeground, #c74e39)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums'
};

const MESSAGE_STYLE: ReactNS.CSSProperties = {
    padding: '10px 14px',
    color: 'var(--theia-descriptionForeground)',
    whiteSpace: 'pre-wrap'
};
