# Workspace Core

The first-party Theia extension that provides Icebox's user-controlled workspace.

## Current behavior

- Replaces the standard IDE shell layout with one full-window main DockPanel.
- Starts with no panels open and no predefined left, right, or bottom regions.
- Registers panel types without automatically opening them.
- Exposes WorkspacePanelRegistry, WorkspaceDockingService and the host services to plugins.
- Persists the panel layout across sessions through theia's layout restorer.
- Persists per-instance panel state alongside the layout: `open(panelId, { state })`
  stores a plain JSON object that is validated, saved with the widget and handed
  back to `createWidget(instanceId, host, state)` when the tab is rebuilt.
- Keeps F1 a workspace menu: panel commands, the plugin manager, and
  `Save Layout` / `Load Layout`. Other commands stay registered and executable, but
  they are not searchable there — they belong in the application's own UI.
- Ships no demo panels or demo commands: every panel comes from a plugin.

Theia's ApplicationShell mainPanel is already a multiple-document TheiaDockPanel. This extension changes the root shell layout rather than implementing another docking engine.

## Run

From the repository root:

    npm install
    npm run build:electron
    npm run start:electron

The workspace starts empty. Press F1 and run a menu entry:

- `Open Terminal` — a real host terminal in the main DockPanel
- `Open File Browser` — the file browser panel
- `Open Git` — the Git panel
- `Open Agent Chat` — the agent chat panel (AG-UI, falling back to ACP or Pi RPC)
- `Open Projects` — project folders and their agent sessions
- `Open Plugin Manager` — enable/disable plugins, review the trust warning, and **Refresh** to re-read the plugin folders after adding or deleting one
- `Save Layout` / `Load Layout` — snapshot the arrangement, restore it later

Every panel above belongs to a plugin under `plugins/`. The host has no
built-in panels of its own.

F1 is the workspace menu, not a mirror of the command registry. It lists panel
commands and the layout commands above, and nothing else: no command is searchable
in it unless something put it there. A panel command enters the menu where the
plugin registers it (`WorkspacePalette.include` in the plugin kernel), and the
layout commands enter it in their own contribution, so a plugin that is disabled
or failed to activate is absent rather than listed and broken. Everything else
keeps working — commands stay registered for key bindings and panels — because
the menu only decides what F1 shows (`WorkspaceQuickCommandService`).

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
(`icebox.workspace.panel`, see `workspace-panel-factory.ts`) instead of being
instantiated directly. Because `WidgetManager` therefore owns the instances,
Theia's `ShellLayoutRestorer` can save the main DockPanel layout and rebuild it
on the next start: splits, tabs, sizes and the last active panel all survive.

The plugin host activates enabled plugins during `FrontendApplicationContribution.onStart`, which Theia runs *before* it initializes the layout, so panel types are registered by the time the restorer asks for them.

Saved layouts reference panel types, not plugin installations. If a panel's plugin is disabled or uninstalled, the tab is restored as an "unavailable" placeholder instead of failing the whole layout; re-enabling the plugin and restarting brings the real panel back. Starting with no saved layout leaves the canvas empty, as before.

### Named layouts

`WorkspaceLayoutService` adds `Save Layout` and `Load Layout`, the only two
commands in the F1 menu that are not a plugin's. A layout is the shell's own
layout data with every widget replaced by the description `WidgetManager` rebuilds
it from (`workspace-layout-service.ts`), which is exactly what the startup restore
uses — so a loaded layout brings back the same panels in the same dock areas with
the same per-panel state, including the agent and working directory an Agent Chat
panel was opened with. Loading calls `ApplicationShell.setLayoutData`, the call
Theia's perspective switching uses to replace a running shell's arrangement, so
nothing is reloaded to apply it.

Two details matter for correctness:

- a widget that cannot be rebuilt aborts the load with a message instead of
  silently dropping a tab, because a half-restored shell is not a layout;
- state is only replayed into widgets that do not exist yet. A widget already
  attached to the shell is live, and replaying `TerminalWidget.restoreState` would
  re-attach to a terminal server channel the running terminal still holds.

Named layouts live in the app's browser storage (`StorageService`), the same
place Theia keeps its own layout — so they belong to the installation and profile
that saved them, and the automatic restore of the last session is unaffected.

## Host panel capabilities

`HostPanelFactoryRegistry` is a curated catalog of native panels the host builds
for plugins. A capability is named by a **stable id** (`icebox.terminal`) — never
a module path or a Theia class name — so the implementation can change without
breaking plugins. Factories are contributed through Inversify
(`HostPanelFactory`); the catalog stays small and grows only as real needs appear.

Today the catalog holds one entry:

- `icebox.terminal` (`TerminalHostPanelFactory`) — creates a real terminal widget
  via `TerminalFrontendContribution.newTerminal()`, the exact call the built-in
  `Open Terminal` command reaches through `ShellTerminalProfile.start()`.
  It returns the terminal widget itself, not a wrapper, so `TerminalService`,
  terminal splits and Theia's own restore keep working.

Plugins reach it only through `api.panels.registerHostPanel` /
`api.panels.hasHostCapability`. The container, `TerminalService`, `WidgetManager`
and raw widget instances are never exposed.

### Factory lifetime and resource ownership

Factory bindings live in this extension's frontend module, so the catalog exists
for the host's whole lifetime — it is not created, owned or disposed by any
plugin. A plugin can only ask for a panel; it cannot register a capability. That
is what keeps a restored terminal restorable after the plugin that exposed it has
been disabled or uninstalled.

Unloading a plugin therefore releases its contributions — commands, panel types,
services and events — and closes the panels it owns (`closePanelsByOwner`, which
filters through `getPluginOwnedInstancesByOwner`). Instances created through a
host capability are **host-owned**: `WorkspacePanelRegistry.isHostPanelType`
marks them, they stay open, and the plugin's disablement never destroys them.

Restoration authority stays single-owner:

- plugin-built panels are registered under `icebox.workspace.panel` and restored by
  the workspace mechanism;
- host-capability panels are registered only under their original Theia factory
  (`terminal`) and restored by Theia.

The same widget is never registered under both, so persistence and ownership can
never disagree.

### Terminal placement

`CanvasApplicationShell` has no bottom panel, but `@theia/terminal` sends panel
terminals to `area: 'bottom'` and opens one during `initializeLayout`. Both are
overridden in `canvas-terminal.ts`:

- `CanvasTerminalShellHandler` forces `area: 'main'` after the parent handler's
  view-column/ref/mode decisions, so the built-in command, the workspace variant,
  splits and restored terminals all land in the shared main DockPanel.
- `CanvasTerminalFrontendContribution` turns `initializeLayout` into a no-op so a
  first start still shows an empty canvas.

## Bundle delivery

The backend serves every plugin's ESM bundle, but the renderer chooses how to
fetch it:

- **Browser target** — the renderer origin is `http://…`, so it fetches the
  served URL under `PLUGIN_ASSET_PREFIX` (same origin, no CORS needed).
- **Electron target** — the renderer runs from a `file://` origin. An HTTP URL on
  the backend is cross-origin and the asset route sends no CORS headers, so
  `fetch` fails there no matter how the URL is built (`TypeError: Failed to
fetch`). The bundle therefore travels over the existing RPC channel via
  `PluginHostClient.readFrontendBundle`.

Both paths end in the same place: the source is rewritten so
`/icebox-host-modules/<file>.js` specifiers point at blob URLs that re-export
the host's own module instances, then imported.

Entrypoint paths in `plugin.json` are normalized before they become URLs
(`./dist/frontend.js` → `dist/frontend.js`); the asset route reads the remainder
of the request URL instead of relying on a wildcard param.

## Plugin manager panel

The manager keeps its layout in `src/browser/plugin/plugin-manager-styles.ts` so
the widget stays about state, not pixels: one panel gutter (`14px 16px`), one row
rhythm (`10px 12px`), a text column holding the name, `id@version`, badges and
description, and an action group pinned right (`margin-left: auto`) with a fixed
button width so Enable/Disable never shift the row. Rows report trust as a badge
because trust is granted by the confirmation dialog the first enable opens; a
toggle that could only revoke it would be a trap.

## Host services

The host publishes its own services under the `icebox.workspace` owner before any plugin activates:

- `workspace.resources` (`WorkspaceResourceService`) — absolute path → stable URI, `stat`, `list`. Plugins must obtain resource URIs here rather than building `file://` strings, so File Browser and Git agree on identity.
- `workspace.selection` (`WorkspaceSelectionService`) — the current `{ uri, ranges }` selection plus change notifications, mirrored onto the `workspace/selection-changed` event.
- `workspace.dialogs` (`WorkspaceDialogService`) — the host's native folder picker. Plugins cannot import Theia's file dialog (it needs the shell's parent window and platform quirks), so Projects asks for a folder through this instead of building a picker.
- `workspace.plugins` (`WorkspacePluginsService`) — the read-only plugin catalogue, provided on the backend side before any plugin activates. It is the counterpart of manifest-declared *data*: a plugin that contributes only `contributes.agents` has no code to register anything, so a consumer (agent-chat) has to ask the host which plugins exist and what they declare. Entries carry `id`, `name`, `version`, `builtIn`, `enabled` and `agents` — never a filesystem path.

Service and event ids live in `@icebox/plugin-api` (`WORKSPACE_SERVICE_IDS`, `WORKSPACE_EVENT_IDS`).

## Plugin roots and trust

`resolvePluginRoots` returns each scanned folder with its kind rather than a bare
path: `<appPath>/../plugins` and `<appPath>/plugins` are **built-in** (trusted,
enabled by default), while `$ICEBOX_PLUGINS_DIR` and `~/.icebox/plugins` are
**third-party** (disabled until the user accepts the warning). The override counts
as third-party on purpose — it points at a folder someone prepared, not at what
this installation shipped; before that distinction was carried by sniffing
`/.icebox/` in the path, an override folder was silently treated as built-in and
trusted.

The manager's **Refresh** re-reads the folders and unloads plugins whose folder
disappeared, so adding or removing a plugin does not need a restart. A plugin may
now also declare no entrypoints at all when it contributes only manifest data;
such a plugin runs no code, which is why its warning names the agent commands it
declares instead of claiming third-party code with full system access.

## Host styles

`WorkspaceHostStyles` (`workspace-host-styles.ts`) injects the few CSS rules the
host has to own, because they correct a Theia behaviour rather than decorate a
panel. The rules live in a `<style>` element added at startup: workspace-core
compiles with plain `tsc` and is not bundled, so it has no stylesheet pipeline,
and a `.css` file nothing imports would be dead weight.

One rule exists today. Theia shows a tab's caption as a tooltip when the pointer
enters the tab. That tooltip is a top-layer popover placed directly below the tab
— on top of the panel's own first rows — and it keeps pointer events, so a click
there is consumed by the tooltip instead of reaching the panel. In a terminal
the first rows are the prompt: the click that should focus the terminal instead
dismisses the tooltip, the terminal is **blurred**, its cursor turns hollow, and
every keystroke goes to the document body. The terminal looks frozen while it is
simply not the focused element. The tooltip is inert text, so it now lets clicks
through:

    .theia-hover.bottom:not(.extended-tab-preview) { pointer-events: none; }

Scope new rules to the exact Theia class and position they correct, and leave
interactive hover variants (`extended-tab-preview`, sidebar menus, the status
bar) with their pointer events.

## Branding

Every user-visible name is the application's own. Two surfaces need host work
because Theia writes its own name into them:

- **Window titles.** `theia build` titles the main window from
  `theia.frontend.config.applicationName` (`Icebox` in both app manifests), but its
  frontend generator hardcodes `Theia — Secondary Window`. Every build therefore
  ends with `scripts/brand-generated-html.mjs <app>`, wired into each app's
  `bundle` script, which rewrites the generated titles in `src-gen/frontend` and
  `lib/frontend`. Patching the generated files is the only option: the templates
  live in a dependency.
- **Theme names.** The bundled color and icon themes are labelled
  `Dark (Theia)`, `File Icons (Theia)`, and those labels reach the theme pickers
  and the matching preference dropdowns. `WorkspaceThemeService` and
  `WorkspaceIconThemeService` (`workspace-branding.ts`) override the *listing*
  only — `getThemes`/`definitions` — so ids, colors, activation and the persisted
  preference value are untouched and an existing `workbench.colorTheme` still
  applies. The preference enums follow automatically because both services build
  them from the same listing.

Third-party attribution stays: the About dialog lists the extensions that are
installed, and libraries that ship their own names keep them.

`electron-app/package.json` carries `productName: "Icebox"`; that name is what
the operating system shows for the application (dock/taskbar/menu label) and what
Electron derives the User-Agent and the user-data directory from
(`~/.config/Icebox` on Linux). Both app manifests also carry the release version,
which the About dialog reports.
