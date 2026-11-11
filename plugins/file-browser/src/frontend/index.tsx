import type * as ReactNS from 'react';
import type {
    FrontendPluginAPI,
    PanelHostTools,
    ResourceStat,
    ResourceUri,
    WorkspaceResourcesService,
    WorkspaceSelectionService
} from '@icebox/plugin-api';
import { FILE_ROOTS_SERVICE, type FileRootsService } from '../shared.js';

const PANEL_FILES = 'files.browser';
const COMMAND_OPEN = 'icebox.file-browser.open';

/** One row of the current folder. */
interface Entry {
    readonly uri: ResourceUri;
    readonly name: string;
    readonly kind: ResourceStat['kind'];
    readonly path: string;
}

/**
 * Native renderer entrypoint for the file browser.
 *
 * The panel is plain React over two host services: `workspace.resources` for
 * metadata and `workspace.selection` for the current selection. Nothing here
 * touches the filesystem API directly, so the identity it publishes is the same
 * one the Git panel uses.
 */
export function activate(api: FrontendPluginAPI): void {
    const resources = api.services.get<WorkspaceResourcesService>('workspace.resources');
    const selection = api.services.get<WorkspaceSelectionService>('workspace.selection');

    api.panels.register({
        id: PANEL_FILES,
        title: 'Files',
        createWidget: (instanceId, host) => {
            const widget = host.createReactWidget(() =>
                host.React.createElement(FileBrowser, {
                    React: host.React,
                    resources,
                    selection,
                    roots: api.services.remote<FileRootsService>(FILE_ROOTS_SERVICE)
                })
            );
            widget.title.label = 'Files';
            widget.title.closable = true;
            widget.id = instanceId;
            return widget;
        }
    });

    api.commands.register({
        id: COMMAND_OPEN,
        title: 'Files: Open Browser',
        execute: () => api.panels.open(PANEL_FILES)
    });
}

interface FileBrowserProps {
    readonly React: PanelHostTools['React'];
    readonly resources: WorkspaceResourcesService;
    readonly selection: WorkspaceSelectionService;
    readonly roots: FileRootsService;
}

/** Where the browser is, and how it got there. */
interface Navigation {
    /** Visited folders, oldest first. */
    readonly entries: readonly string[];
    /** Index of the folder on screen; everything after it is redo history. */
    readonly cursor: number;
}

/**
 * One folder at a time, with back/forward/up navigation.
 *
 * The folder on screen is a real directory listing, so a click on a directory
 * descends into it and `up` climbs back out, which is what the arrow buttons
 * imply. The history keeps the folder names, not a copy of their contents.
 */
function FileBrowser(props: FileBrowserProps): ReactNS.ReactNode {
    const { React, resources, selection } = props;
    const [home, setHome] = React.useState<string>();
    const [nav, setNav] = React.useState<Navigation>();
    const [entries, setEntries] = React.useState<readonly Entry[]>();
    const [failure, setFailure] = React.useState<string>();
    const [startError, setStartError] = React.useState<string>();
    const [selected, setSelected] = React.useState<ResourceUri>();
    const [refreshKey, setRefreshKey] = React.useState(0);

    const current = nav ? nav.entries[nav.cursor] : undefined;

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const resolved = await props.roots.roots();
                if (cancelled) {
                    return;
                }
                const start = resolved.roots[0];
                setHome(start);
                setNav(start ? { entries: [start], cursor: 0 } : undefined);
            } catch (cause) {
                if (!cancelled) {
                    setStartError(cause instanceof Error ? cause.message : String(cause));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [props.roots]);

    React.useEffect(() => {
        // `PluginDisposer` may return a promise, which React's cleanup contract
        // does not accept; await it explicitly instead of returning it.
        const dispose = selection.onDidChange(next => setSelected(next?.uri));
        return () => {
            void dispose();
        };
    }, [selection]);

    // List the folder on screen; the refresh button re-runs this.
    React.useEffect(() => {
        if (!current) {
            return;
        }
        let cancelled = false;
        setEntries(undefined);
        setFailure(undefined);
        void (async () => {
            try {
                const stats = await resources.list(resources.fromPath(current));
                if (!cancelled) {
                    setEntries(stats.map(stat => toEntry(stat)).sort(compareEntries));
                }
            } catch (cause) {
                if (!cancelled) {
                    setFailure(cause instanceof Error ? cause.message : String(cause));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [current, refreshKey, resources]);

    /** Descends into a folder, dropping any forward history. */
    const go = (path: string): void => {
        setNav(previous => previous
            ? { entries: [...previous.entries.slice(0, previous.cursor + 1), path], cursor: previous.cursor + 1 }
            : { entries: [path], cursor: 0 });
    };

    const back = (): void => {
        setNav(previous => previous && previous.cursor > 0
            ? { ...previous, cursor: previous.cursor - 1 }
            : previous);
    };

    const forward = (): void => {
        setNav(previous => previous && previous.cursor < previous.entries.length - 1
            ? { ...previous, cursor: previous.cursor + 1 }
            : previous);
    };

    const parent = current ? parentPath(current) : undefined;
    const up = (): void => {
        if (parent) {
            go(parent);
        }
    };

    const onSelect = (uri: ResourceUri): void => {
        setSelected(uri);
        selection.set({
            uri,
            ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }]
        });
    };

    const iconButton = (
        icon: string,
        label: string,
        title: string,
        onClick: () => void,
        disabled = false
    ): ReactNS.ReactNode => React.createElement(
        'button',
        {
            key: label,
            type: 'button',
            style: { ...ICON_BUTTON_STYLE, ...(disabled ? DISABLED_STYLE : {}) },
            title,
            'aria-label': label,
            disabled,
            onClick
        },
        React.createElement('i', { className: `codicon codicon-${icon}`, 'aria-hidden': true })
    );

    if (startError) {
        return React.createElement('div', { style: MESSAGE_STYLE }, `Cannot start the file browser: ${startError}`);
    }
    if (!nav || !current) {
        return React.createElement('div', { style: MESSAGE_STYLE }, 'Loading…');
    }

    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement(
            'div',
            { style: HEADER_STYLE },
            React.createElement(
                'div',
                { style: NAV_STYLE },
                iconButton('arrow-left', 'Back', 'Go to the previous folder', back, nav.cursor === 0),
                iconButton('arrow-right', 'Forward', 'Go to the next folder', forward,
                    nav.cursor >= nav.entries.length - 1),
                iconButton('arrow-up', 'Up one folder', 'Go to the parent folder', up, !parent)
            ),
            React.createElement(
                'span',
                { style: PATH_STYLE, title: current },
                displayPath(current, home)
            ),
            iconButton('refresh', 'Refresh', 'Re-read this folder', () => setRefreshKey(key => key + 1))
        ),
        React.createElement(
            'div',
            { style: LIST_STYLE },
            failure
                ? React.createElement('div', { style: MESSAGE_STYLE }, `Cannot list this folder: ${failure}`)
                : undefined,
            !failure && !entries
                ? React.createElement('div', { style: MESSAGE_STYLE }, 'Loading…')
                : undefined,
            !failure && entries && entries.length === 0
                ? React.createElement('div', { style: MESSAGE_STYLE }, 'This folder is empty.')
                : undefined,
            (entries ?? []).map(entry =>
                React.createElement(
                    'button',
                    {
                        key: entry.uri,
                        type: 'button',
                        style: {
                            ...ROW_STYLE,
                            ...(selected === entry.uri ? SELECTED_STYLE : {})
                        },
                        title: entry.path,
                        onClick: () => (entry.kind === 'directory' ? go(entry.path) : onSelect(entry.uri))
                    },
                    React.createElement('i', {
                        className: `codicon codicon-${entry.kind === 'directory' ? 'folder' : 'file'}`,
                        'aria-hidden': true
                    }),
                    React.createElement('span', { style: NAME_STYLE }, entry.name)
                )
            )
        )
    );
}

function toEntry(stat: ResourceStat): Entry {
    return {
        uri: stat.uri,
        name: stat.name,
        kind: stat.kind,
        path: filePath(stat.uri)
    };
}

function compareEntries(left: Entry, right: Entry): number {
    if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
}

/** `file:///home/user/x` → `/home/user/x`, tolerating other schemes. */
function filePath(uri: ResourceUri): string {
    const withoutScheme = uri.replace(/^file:\/\//, '');
    try {
        return decodeURIComponent(withoutScheme);
    } catch {
        return withoutScheme;
    }
}

/** The separator this path uses, so Windows paths keep their backslashes. */
function separatorOf(path: string): string {
    return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/**
 * Parent of a path, or `undefined` at the filesystem root.
 *
 * `/home/user` → `/home`, `C:\Users\user` → `C:\Users`, and `/` or `C:\` has no
 * parent to climb to.
 */
export function parentPath(path: string): string | undefined {
    const trimmed = path.replace(/[/\\]+$/, '');
    const separator = separatorOf(trimmed);
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (index < 0) {
        // A bare drive letter (`C:`) or a relative name: nothing above it.
        return undefined;
    }
    if (index === 0) {
        // `/home` has a parent, and it is the root: `/`.
        return trimmed.length === 1 ? undefined : separator;
    }
    const parent = trimmed.slice(0, index);
    // `C:` is a drive, whose parent form keeps the separator: `C:\`.
    return /^[A-Za-z]:$/.test(parent) ? `${parent}${separator}` : parent;
}

/** Shows the home prefix as `~` so a deep path stays readable. */
function displayPath(path: string, home: string | undefined): string {
    if (!home) {
        return path;
    }
    const normalizedHome = home.replace(/[/\\]+$/, '');
    if (path === normalizedHome) {
        return '~';
    }
    if (path.startsWith(`${normalizedHome}${separatorOf(normalizedHome)}`)) {
        return `~${path.slice(normalizedHome.length)}`;
    }
    return path;
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
    gap: '6px',
    // Same header box as the Git and Agent Chat panels (6px + a 22px control).
    padding: '6px 10px',
    borderBottom: '1px solid var(--theia-panel-border)'
};

const NAV_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0
};

const PATH_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--theia-descriptionForeground)',
    fontSize: '11px'
};

/** Square, icon-only button that lines up with the panel header. */
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

const DISABLED_STYLE: ReactNS.CSSProperties = {
    opacity: 0.4,
    cursor: 'default'
};

const LIST_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    overflow: 'auto',
    padding: '4px 0'
};

const MESSAGE_STYLE: ReactNS.CSSProperties = {
    padding: '10px',
    color: 'var(--theia-descriptionForeground)',
    whiteSpace: 'pre-wrap'
};

const ROW_STYLE: ReactNS.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    color: 'inherit',
    border: 'none',
    padding: '3px 10px',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden'
};

const NAME_STYLE: ReactNS.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis'
};

const SELECTED_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-list-activeSelectionBackground)',
    color: 'var(--theia-list-activeSelectionForeground)'
};
