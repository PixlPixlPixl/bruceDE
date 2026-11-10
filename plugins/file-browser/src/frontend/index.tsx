import type * as ReactNS from 'react';
import type {
    FrontendPluginAPI,
    PanelHostTools,
    ResourceStat,
    ResourceUri,
    WorkspaceResourcesService,
    WorkspaceSelectionService
} from '@brucede/plugin-api';
import { FILE_ROOTS_SERVICE, type FileRootsService } from '../shared.js';

const PANEL_FILES = 'files.browser';
const COMMAND_OPEN = 'bruce.file-browser.open';

/** Everything a tree node needs; passed as a prop instead of a React context. */
interface TreeContext {
    readonly React: PanelHostTools['React'];
    readonly resources: WorkspaceResourcesService;
    readonly onSelect: (uri: ResourceUri) => void;
    readonly selected?: ResourceUri;
}

interface TreeItem {
    readonly uri: ResourceUri;
    readonly name: string;
    readonly kind: ResourceStat['kind'];
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

/** Root list + lazily expanded directory tree. */
function FileBrowser(props: FileBrowserProps): ReactNS.ReactNode {
    const { React, resources, selection } = props;
    const [roots, setRoots] = React.useState<readonly string[]>([]);
    const [error, setError] = React.useState<string>();
    const [selected, setSelected] = React.useState<ResourceUri>();
    const [refreshKey, setRefreshKey] = React.useState(0);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const resolved = await props.roots.roots();
                if (!cancelled) {
                    setRoots(resolved.roots);
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
    }, [refreshKey]);

    React.useEffect(() => {
        // `PluginDisposer` may return a promise, which React's cleanup contract
        // does not accept; await it explicitly instead of returning it.
        const dispose = selection.onDidChange(next => setSelected(next?.uri));
        return () => {
            void dispose();
        };
    }, [selection]);

    const onSelect = (uri: ResourceUri): void => {
        setSelected(uri);
        selection.set({
            uri,
            ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }]
        });
    };

    const context: TreeContext = { React, resources, onSelect, selected };

    if (error) {
        return React.createElement('div', { style: ROOT_STYLE }, `Cannot read project root: ${error}`);
    }
    if (roots.length === 0) {
        return React.createElement('div', { style: ROOT_STYLE }, 'Loading…');
    }
    return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement(
            'div',
            { style: HEADER_STYLE },
            React.createElement('span', { style: TITLE_STYLE }, 'Files'),
            React.createElement(
                'button',
                {
                    type: 'button',
                    style: BUTTON_STYLE,
                    onClick: () => setRefreshKey(key => key + 1)
                },
                'Refresh'
            )
        ),
        React.createElement(
            'div',
            { style: LIST_STYLE },
            roots.map(root =>
                React.createElement(Directory, {
                    key: `${root}:${refreshKey}`,
                    ...context,
                    path: root,
                    name: baseName(root),
                    depth: 0
                })
            )
        )
    );
}

interface DirectoryProps extends TreeContext {
    readonly path: string;
    readonly name: string;
    readonly depth: number;
}

/** One directory row plus, when expanded, its children. */
function Directory(props: DirectoryProps): ReactNS.ReactNode {
    const { React, path, name, depth } = props;
    const [open, setOpen] = React.useState(depth === 0);
    const [items, setItems] = React.useState<readonly TreeItem[]>();
    const [failed, setFailed] = React.useState<string>();

    React.useEffect(() => {
        if (!open || items) {
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const stats = await props.resources.list(props.resources.fromPath(path));
                if (!cancelled) {
                    setItems(stats.map(toItem).sort(compareItems));
                }
            } catch (cause) {
                if (!cancelled) {
                    setFailed(cause instanceof Error ? cause.message : String(cause));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, items, path, props.resources]);

    const row = rowStyle(depth);
    return React.createElement(
        React.Fragment,
        undefined,
        React.createElement(
            'button',
            {
                type: 'button',
                style: { ...row, ...DIRECTORY_STYLE },
                onClick: () => setOpen(value => !value)
            },
            `${open ? '▾' : '▸'} ${name}`
        ),
        open && failed ? React.createElement('div', { style: { ...row, opacity: 0.6 } }, failed) : undefined,
        open && !items && !failed ? React.createElement('div', { style: { ...row, opacity: 0.5 } }, 'Loading…') : undefined,
        open
            ? (items ?? []).map(item =>
                  item.kind === 'directory'
                      ? React.createElement(Directory, {
                            key: item.uri,
                            ...props,
                            path: filePath(item.uri),
                            name: item.name,
                            depth: depth + 1
                        })
                      : React.createElement(
                            'button',
                            {
                                key: item.uri,
                                type: 'button',
                                style: {
                                    ...rowStyle(depth + 1),
                                    ...(props.selected === item.uri ? SELECTED_STYLE : FILE_STYLE)
                                },
                                onClick: () => props.onSelect(item.uri)
                            },
                            item.name
                        )
              )
            : undefined
    );
}

function toItem(stat: ResourceStat): TreeItem {
    return { uri: stat.uri, name: stat.name, kind: stat.kind };
}

function compareItems(left: TreeItem, right: TreeItem): number {
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

function baseName(path: string): string {
    const trimmed = path.replace(/[/\\]+$/, '');
    const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return separator === -1 ? trimmed : trimmed.slice(separator + 1) || trimmed;
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

const LIST_STYLE: ReactNS.CSSProperties = {
    flex: '1',
    overflow: 'auto',
    padding: '4px 0'
};

const ROOT_STYLE: ReactNS.CSSProperties = {
    padding: '12px',
    opacity: 0.7
};

const DIRECTORY_STYLE: ReactNS.CSSProperties = {
    fontWeight: 600,
    opacity: 0.95
};

const FILE_STYLE: ReactNS.CSSProperties = {};

const SELECTED_STYLE: ReactNS.CSSProperties = {
    background: 'var(--theia-list-activeSelectionBackground)',
    color: 'var(--theia-list-activeSelectionForeground)'
};

function rowStyle(depth: number): ReactNS.CSSProperties {
    return {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        padding: '2px 10px',
        paddingLeft: `${10 + depth * 14}px`,
        fontFamily: 'inherit',
        fontSize: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
    };
}
