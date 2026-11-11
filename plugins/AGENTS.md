# AGENTS.md — plugins

Compact instructions for agents adding plugins to Icebox.

## Rule zero

A plugin is **one self-contained folder** under `plugins/<plugin-id>/`. It owns its
manifest, package metadata, source, assets and built bundles. The host discovers
and loads it as-is: **never edit `workspace-core/`, `packages/`, or the app targets
to add a plugin.** If a plugin cannot work without host changes, the runtime is
missing a capability — report it instead of patching the host.

Plugins are **trusted native code, not sandboxed**. Frontend code runs in the
normal Theia renderer, backend code in the normal Node process, with full
filesystem/process/network access.

## Folder layout

```text
plugins/<plugin-id>/
  plugin.json               manifest (source of truth for discovery)
  package.json              optional workspace metadata
  src/frontend/index.tsx    optional renderer entry, exports activate(api)
  src/backend/index.ts      optional Node entry, exports activate(api)   [!]
  src/**                    any other sources/assets you need
  dist/frontend.js          built ESM bundle (git-ignored, commit nothing)
  dist/backend.js           built ESM bundle (git-ignored)
```

`[!]` The bundler only detects `src/backend/index.ts` (not `.tsx`/`.mts`). Keep the
backend entry at that exact path.

## Discovery

Scanned on start, in order: `$ICEBOX_PLUGINS_DIR` → `<appPath>/../plugins` →
`<appPath>/plugins` → `~/.icebox/plugins`. State (trust/enabled) is stored in
`~/.icebox/plugins.json` (`$ICEBOX_STATE_DIR` overrides).

- Folders under `plugins/` in this repo are **built-in**: trusted by definition
  and **enabled by default**.
- Folders under `~/.icebox/plugins` are **third-party**: disabled until the user
  accepts the full-system-access warning in the plugin manager.
- Problems never block startup. They surface as diagnostics in the plugin manager
  (`Open Plugin Manager`) and in the backend log with `[plugin-host]`
  prefixes. Check there first when a plugin does not appear.

## plugin.json

```json
{
  "id": "icebox.terminal",
  "name": "Terminal",
  "version": "0.1.0",
  "apiVersion": 1,
  "entrypoints": { "frontend": "./dist/frontend.js", "backend": "./dist/backend.js" },
  "dependencies": { "icebox.workspace": "^0.1.0" },
  "contributes": {
    "panels": [{ "id": "terminal.main", "title": "Terminal" }],
    "commands": [{ "id": "icebox.terminal.open", "title": "Open Terminal" }],
    "services": ["terminal.sessions"]
  }
}
```

Validation is strict and runs before any code is imported:

- `id`: lower-case, namespaced, `/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/`, globally unique
  (prefix with `icebox.` and keep it stable — it identifies the plugin everywhere).
- `version`: semver `x.y.z`.
- `apiVersion`: integer; must equal the host's supported version (`1`).
- `entrypoints`: relative, no `..`, must end in `.js`/`.mjs`; at least one of
  `frontend`/`backend` is required.
- `dependencies`: map of plugin id → version range. `icebox.workspace` is the host
  and always satisfied; any other id must resolve to a discovered plugin whose
  `version` satisfies the range, or a diagnostic is raised.
- `contributes.commands[].title`: the F1 menu label, verbatim. The F1 menu holds
  only panel commands and the layout commands, so a title must read as an action
  on the plugin (`Open Git`), never as a category (`Git: Open Changes`). Every
  command a plugin registers through `api.commands.register` joins the menu
  automatically; nothing else does.
- `contributes`: declaration only — it lets the manager show capabilities before
  activation. The authoritative registration is `api.panels.register` etc. in
  `activate`.

## Build and run

```bash
npm ci                       # compiles @icebox/* and workspace-core (root postinstall)
node packages/plugin-build/build.mjs plugins/<plugin-id>   # one plugin
npm run build:plugins                                      # every plugin
npm run build:electron                                     # full app
npm run start:electron
```

The `@icebox/*` contracts are workspace packages, not published to npm. Their
`lib/` output is not committed, so any TypeScript run needs the compiled
types first: `npm run build:workspace-core` if you installed with
`--ignore-scripts`.

Inside a plugin, `npm run build` should be
`node ../../packages/plugin-build/build.mjs .`.

The bundler does not typecheck. To do so, run `tsc` over the plugin sources
before committing:

```bash
node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict \
  --jsx react --module esnext --moduleResolution bundler --target es2022 \
  $(find plugins -name '*.ts' -o -name '*.tsx')
```

Frontend bundles leave the shared host modules external; the renderer rewrites
those specifiers to the host's own instances at load time. **Never bundle your own
React or Lumino** — import them from the host (`host.React`, `host.widgets`), or
import them directly and let the bundler alias them. Allowed: `react`,
`react-dom`, `@lumino/widgets`, `@lumino/signaling`, `@lumino/domutils`,
`@lumino/coreutils`, `@theia/core/lib/browser`, `@theia/core/lib/common`,
`@theia/core/lib/browser/widgets/react-widget`, `@icebox/plugin-api`.
Backend bundles are self-contained ESM (only `electron` stays external).

## The runtime contract

Export `activate(api)` from each entrypoint. Everything registered through `api`
belongs to the plugin and is disposed when the plugin unloads.

Frontend (`FrontendPluginAPI`):

- `api.panels.register({ id, title, createWidget })` — registers a panel **type**.
  `createWidget(instanceId, host, state?)` returns a fresh widget per instance.
- `api.panels.registerHostPanel({ id, title, capabilityId, options? })` — registers
  a panel the **host** builds for you (see "Host capabilities" below).
- `api.panels.hasHostCapability(capabilityId)` — whether this build exposes it.
- `api.panels.open(panelId, opts?)` / `close(instanceId)` / `getOpenInstances()`.
  `opts.mode`: `split-left|split-right|split-top|split-bottom|tab-before|tab-after`,
  `opts.ref`: widget id, `opts.state`: JSON instance state (see below).

### Per-instance state

Each panel instance can carry state: `open(panelId, { state })` passes a plain
JSON object that the host persists with the layout and hands back to
`createWidget(instanceId, host, state)` after a restart. Use it for anything that
belongs to *that tab* — which agent a chat talks to, which file a viewer shows.

- State must be JSON (objects, arrays, strings, numbers, booleans, null). The host
  rejects anything else, because it could not survive a save/restore.
- Never put "the current thing" in plugin-level state: two open tabs of the same
  panel type must not fight over one value.
- Derive per-tab data from `state` + `instanceId` on mount; do not assume the
  widget that exists now is the one that opened the tab originally.
- `api.commands.register({ id, title, execute })`.
- `api.ui` — `React`, `widgets`, `createReactWidget(render)`.
- `api.services` — `provide/get/has` plus `remote<T>(serviceId)`.
- `api.events` — `on/emit`.
- `api.onDispose(fn)`, `api.origin {builtIn, directory}`, `api.manifest`.

Backend (`BackendPluginAPI`): `api.services`, `api.events`, `api.onDispose`,
`api.workspace {root, cwd}`, `api.manifest`, `api.origin`. No panels or commands.

```tsx
import type { FrontendPluginAPI, PanelHostTools } from '@icebox/plugin-api';

export function activate(api: FrontendPluginAPI): void {
    api.panels.register({
        id: 'main',
        title: 'Files',
        createWidget: (instanceId, host, state) => myWidget(host, instanceId, state)
    });
    api.commands.register({
        id: 'icebox.files.open',
        title: 'Open File Browser',
        execute: () => api.panels.open('main')
    });
}
```

## Host capabilities

Some panels need real host functionality — a terminal, later an editor or a diff
view. Do not reimplement it and do not import Theia internals. Adopt a curated
**host capability** instead:

```ts
import { HOST_PANEL_CAPABILITIES } from '@icebox/plugin-api';

api.panels.registerHostPanel({
    id: 'terminal.main',
    title: 'Terminal',
    capabilityId: HOST_PANEL_CAPABILITIES.terminal
});
api.commands.register({
    id: 'icebox.terminal.open',
    title: 'Open Terminal',
    execute: () => api.panels.open('terminal.main')
});
```

A capability id (`icebox.terminal`) is a **stable host contract**, not an import
path or a Theia class name. The host owns widget creation, rendering, persistence
and disposal; you never receive a raw host widget, a DI container or a
`WidgetManager`. Always gate on `hasHostCapability` (or let `registerHostPanel`
throw) so a host without that capability fails loudly instead of showing an empty
panel.

Available today: `HOST_PANEL_CAPABILITIES.terminal` (`icebox.terminal`) — the
host's native terminal, the same widget the built-in `Open Terminal`
command creates. New capabilities are added host-side; a plugin cannot define one.

### Who owns what

- **The host owns the factory.** A capability factory is contributed by the host's
  Theia integration, never by a plugin, and it lives for the host's lifetime. You
  can only *request* that the host create or expose a panel. A plugin must never
  register, replace or dispose a host factory.
- **The host owns what it creates.** A panel produced through a capability belongs
  to the host and to the user. Disabling your plugin removes your commands, your
  panel *type* and your services/events, and closes panels your plugin owns. It
  does **not** destroy host-capability resources — a running terminal stays open
  and the host restores it on the next launch. Never assume unloading your plugin
  tears down host-created state.
- **Exactly one restoration owner per widget.** Panel widgets your plugin builds
  are restored by the workspace plugin-panel mechanism. Widgets built by a host
  capability are restored by their original Theia factory. The same widget is
  never registered under both. Do not try to make the two look uniform in
  `plugin.json` or in your code.

Future note: a layout-level ownership marker only becomes worthwhile if Icebox
introduces a kind of panel whose **UI and lifecycle genuinely belong to a plugin**
and must vanish completely when that plugin is disabled. Host-capability panels
are the opposite case — host UI, host lifecycle — so they deliberately have no
marker. Do not add one for them.

## Services and events

One registry per side (renderer, backend), shared across plugins and keyed by
owner. Use `WORKSPACE_SERVICE_IDS` / `WORKSPACE_EVENT_IDS` from
`@icebox/plugin-api`; never invent duplicate ids.

Provided by the host before any plugin activates:

- `workspace.resources` → `WorkspaceResourcesService`: `fromPath(path) → uri`,
  `stat(uri)`, `list(uri)`. **Always obtain resource URIs here** instead of
  building `file://` strings, so File Browser and Git agree on identity.
- `workspace.selection` → `WorkspaceSelectionService`: `get/set/onDidChange`;
  changes also arrive as `workspace/selection-changed`.

Reserved for feature plugins: `git.repository`, `agent.sessions`,
`git/changes-updated`.

Cross-boundary calls: `api.services.remote<T>('git.repository')` gives the renderer
a typed view of a **backend** plugin's service. Every method becomes one RPC call
over Theia's existing channel, so arguments and results must be JSON-serializable.
It throws in backend code — backend plugins use `get` in-process.

## Hard rules

1. **No cross-plugin imports.** Communicate through services and events only.
2. **Never prescribe placement.** `activate` registers panel *types* and commands;
   it must not open panels. Only a user action opens a panel.
3. **Dispose everything you start.** Register watchers/timers/processes/listeners
   via `onDispose` (or the disposer `provide`/`on`/`register` return). Cordis tears
   down the fiber, but it cannot see raw Node handles. What the host started
   through a capability is not yours to dispose.
4. **Keep frontend and backend split.** Node APIs only in `src/backend`.
5. **Never import Theia internals to fake host UI.** If you need a terminal or
   another native surface, adopt a host capability. Bundling `@theia/*` or
   `xterm` into a plugin produces duplicate containers and widgets the shell
   cannot adopt — the bundler allowlist will not link them anyway.
6. **One panel instance, one session.** If a panel owns a process, connection or
   transcript, key it by the instance id — never by "the current one". Opening a
   second tab must not disturb the first, and a new tab is a new tab
   (`open(panelId, { ref: instanceId, mode: 'tab-after', state })`), not a
   reconfiguration of the open one.
7. **Build real functionality.** No test-only, placeholder or demo plugins, and
   no demo panels dressed up as features; a scaffold must exercise the real
   contract and then be completed.
8. **Theme with host variables.** The application defaults to the dark theme
   (`theia-dark`), so hardcoded colors break it. Style with
   `var(--theia-editor-background)`, `var(--theia-editor-foreground)`,
   `var(--theia-descriptionForeground)`, `var(--theia-panel-border)` and friends;
   a literal `#fff` or `white` background is a bug, not a default.
   Icons come from the codicon font the shell already loads
   (`<i class="codicon codicon-refresh">`): no bundled icon assets, no image
   files. An icon-only button keeps an `aria-label` and a `title` so it stays
   reachable and explained, and centres its glyph with flexbox rather than a
   line height.
9. **Panel headers share one box.** A panel's header is `6px 10px` padding
   around a 22px control, with a `1px` `--theia-panel-border` bottom border,
   so the separator line lands on the same pixel row in every panel docked side
   by side. The control drives the height — a 13px label next to an 18px button
   makes a 31px header while the neighbouring panel is 35px. Give the header's
   controls a fixed `height: '22px'` (icon buttons `22px × 22px`, text buttons
   `height: '22px'` with horizontal padding only) instead of sizing them by
   padding and font size.
10. **Never promise code unload.** Native ESM module records may stay cached;
   reload/restart is the answer when a module cannot be replaced safely.

## Checklist before you finish

- [ ] `plugin.json` valid: namespaced id, semver, `apiVersion: 1`, existing
      bundles under `dist/`
- [ ] `npm run build:plugins` succeeds; `dist/` not committed
- [ ] plugin appears in `Open Plugin Manager` with no diagnostics
- [ ] its open command docks a panel into the shared main area, and the panel
      paints content (a widget only renders when `update()` is requested —
      `host.createReactWidget` already does this on attach; call `widget.update()`
      yourself if you replace that path)
- [ ] styles resolve under the dark theme: no hardcoded light colors
- [ ] native panels go through `registerHostPanel`, not a bundled Theia copy
- [ ] disabling it closes every panel it opened and leaves no orphan commands
- [ ] reopening the app restores panels the user left open
- [ ] no host files modified
