# Workspace Core

The first-party Theia extension that provides BruceDE's user-controlled workspace.

## Current behavior

- Replaces the standard IDE shell layout with one full-window main DockPanel.
- Starts with no panels open and no predefined left, right, or bottom regions.
- Registers panel types without automatically opening them.
- Exposes WorkspacePanelRegistry and WorkspaceDockingService to other extensions.
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
