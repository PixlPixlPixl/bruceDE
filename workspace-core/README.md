# Workspace Core

The first-party Theia extension that provides BruceDE's user-controlled workspace.

## Current behavior

- Replaces the standard IDE shell layout with one full-window main DockPanel.
- Starts with no panels open and no predefined left, right, or bottom regions.
- Registers panel types without automatically opening them.
- Exposes WorkspacePanelRegistry, WorkspaceDockingService and the host services to plugins.
- Persists the panel layout across sessions through theia's layout restorer.
- Includes temporary demo commands to verify splitting and tab docking.

Theia's ApplicationShell mainPanel is already a multiple-document TheiaDockPanel. This extension changes the root shell layout rather than implementing another docking engine.

## Run

From the repository root:

    npm install
    npm run build:electron
    npm run start:electron

Press F1 and run: Workspace: Open docking demo layout.
This creates three temporary panels. They can then be dragged, resized, split, or combined into tabs.

The individual demo commands are:
- Workspace: Open demo terminal panel
- Workspace: Open demo agent panel
- Workspace: Open demo Git panel

These are visual placeholders only. No terminal or agent process is started.

## Contribute a panel from another Theia extension

Inject WorkspacePanelRegistry and register a panel definition:

    registry.registerPanel({
        id: 'example.panel',
        title: 'Example',
        createWidget: instanceId => new ExampleWidget(instanceId)
    });

Inject WorkspaceDockingService to open it:

    await docking.openPanel('example.panel');

To position it relative to an existing widget:

    await docking.openPanel('example.panel', {
        ref: existingWidget,
        mode: 'split-right'
    });

Supported modes include split-left, split-right, split-top, split-bottom, tab-before, and tab-after.
A panel definition does not specify a region or default position. Extensions register capabilities; the user controls the arrangement.

## Layout persistence

Every panel instance is created through a single host `WidgetFactory`
(`bruce.workspace.panel`, see `workspace-panel-factory.ts`) instead of being
instantiated directly. Because `WidgetManager` therefore owns the instances,
Theia's `ShellLayoutRestorer` can save the main DockPanel layout and rebuild it
on the next start: splits, tabs, sizes and the last active panel all survive.

The plugin host activates enabled plugins during `FrontendApplicationContribution.onStart`, which Theia runs *before* it initializes the layout, so panel types are registered by the time the restorer asks for them.

Saved layouts reference panel types, not plugin installations. If a panel's plugin is disabled or uninstalled, the tab is restored as an "unavailable" placeholder instead of failing the whole layout; re-enabling the plugin and restarting brings the real panel back. Starting with no saved layout leaves the canvas empty, as before.

## Host services

The host publishes its own services under the `bruce.workspace` owner before any plugin activates:

- `workspace.resources` (`WorkspaceResourceService`) — absolute path → stable URI, `stat`, `list`. Plugins must obtain resource URIs here rather than building `file://` strings, so File Browser and Git agree on identity.
- `workspace.selection` (`WorkspaceSelectionService`) — the current `{ uri, ranges }` selection plus change notifications, mirrored onto the `workspace/selection-changed` event.

Service and event ids live in `@brucede/plugin-api` (`WORKSPACE_SERVICE_IDS`, `WORKSPACE_EVENT_IDS`).
