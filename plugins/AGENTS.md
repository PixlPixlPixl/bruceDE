# AGENTS.md — plugins

Compact instructions for agents adding plugins to BruceDE.

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

Scanned on start, in order: `$BRUCEDE_PLUGINS_DIR` → `<appPath>/../plugins` →
`<appPath>/plugins` → `~/.brucede/plugins`. State (trust/enabled) is stored in
`~/.brucede/plugins.json` (`$BRUCEDE_STATE_DIR` overrides).

- Folders under `plugins/` in this repo are **built-in**: trusted by definition
  and **enabled by default**.
- Folders under `~/.brucede/plugins` are **third-party**: disabled until the user
  accepts the full-system-access warning in the plugin manager.
- Problems never block startup. They surface as diagnostics in the plugin manager
  (`Plugins: Open Plugin Manager`) and in the backend log with `[plugin-host]`
  prefixes. Check there first when a plugin does not appear.

## plugin.json

```json
{
  "id": "bruce.terminal",
  "name": "Terminal",
  "version": "0.1.0",
  "apiVersion": 1,
  "entrypoints": { "frontend": "./dist/frontend.js", "backend": "./dist/backend.js" },
  "dependencies": { "bruce.workspace": "^0.1.0" },
  "contributes": {
    "panels": [{ "id": "terminal.main", "title": "Terminal" }],
    "commands": [{ "id": "bruce.terminal.open", "title": "Terminal: New Terminal" }],
    "services": ["terminal.sessions"]
  }
}
```

Validation is strict and runs before any code is imported:

- `id`: lower-case, namespaced, `/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/`, globally unique
  (prefix with `bruce.` and keep it stable — it identifies the plugin everywhere).
- `version`: semver `x.y.z`.
- `apiVersion`: integer; must equal the host's supported version (`1`).
- `entrypoints`: relative, no `..`, must end in `.js`/`.mjs`; at least one of
  `frontend`/`backend` is required.
- `dependencies`: map of plugin id → version range. `bruce.workspace` is the host
  and always satisfied; any other id must resolve to a discovered plugin whose
  `version` satisfies the range, or a diagnostic is raised.
- `contributes`: declaration only — it lets the manager show capabilities before
  activation. The authoritative registration is `api.panels.register` etc. in
  `activate`.

## Build and run

```bash
node packages/plugin-build/build.mjs plugins/<plugin-id>   # one plugin
npm run build:plugins                                      # every plugin
npm run build:electron                                     # full app
npm run start:electron
```

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
`@theia/core/lib/browser/widgets/react-widget`, `@brucede/plugin-api`.
Backend bundles are self-contained ESM (only `electron` stays external).

## The runtime contract

Export `activate(api)` from each entrypoint. Everything registered through `api`
belongs to the plugin and is disposed when the plugin unloads.

Frontend (`FrontendPluginAPI`):

- `api.panels.register({ id, title, createWidget })` — registers a panel **type**.
  `createWidget(instanceId, host)` returns a fresh widget per instance.
- `api.panels.registerHostPanel({ id, title, capabilityId, options? })` — registers
  a panel the **host** builds for you (see "Host capabilities" below).
- `api.panels.hasHostCapability(capabilityId)` — whether this build exposes it.
- `api.panels.open(panelId, opts?)` / `close(instanceId)` / `getOpenInstances()`.
  `opts.mode`: `split-left|split-right|split-top|split-bottom|tab-before|tab-after`,
  `opts.ref`: widget id.
- `api.commands.register({ id, title, execute })`.
- `api.ui` — `React`, `widgets`, `createReactWidget(render)`.
- `api.services` — `provide/get/has` plus `remote<T>(serviceId)`.
- `api.events` — `on/emit`.
- `api.onDispose(fn)`, `api.origin {builtIn, directory}`, `api.manifest`.

Backend (`BackendPluginAPI`): `api.services`, `api.events`, `api.onDispose`,
`api.workspace {root, cwd}`, `api.manifest`, `api.origin`. No panels or commands.

```tsx
import type { FrontendPluginAPI, PanelHostTools } from '@brucede/plugin-api';

export function activate(api: FrontendPluginAPI): void {
    api.panels.register({
        id: 'main',
        title: 'Files',
        createWidget: (instanceId, host) => myWidget(host, instanceId)
    });
    api.commands.register({
        id: 'bruce.files.open',
        title: 'Files: Open Browser',
        execute: () => api.panels.open('main')
    });
}
```

## Host capabilities

Some panels need real host functionality — a terminal, later an editor or a diff
view. Do not reimplement it and do not import Theia internals. Adopt a curated
**host capability** instead:

```ts
import { HOST_PANEL_CAPABILITIES } from '@brucede/plugin-api';

api.panels.registerHostPanel({
    id: 'terminal.main',
    title: 'Terminal',
    capabilityId: HOST_PANEL_CAPABILITIES.terminal
});
api.commands.register({
    id: 'bruce.terminal.open',
    title: 'Terminal: New Terminal',
    execute: () => api.panels.open('terminal.main')
});
```

A capability id (`brucede.terminal`) is a **stable host contract**, not an import
path or a Theia class name. The host owns widget creation, rendering, persistence
and disposal; you never receive a raw host widget, a DI container or a
`WidgetManager`. Always gate on `hasHostCapability` (or let `registerHostPanel`
throw) so a host without that capability fails loudly instead of showing an empty
panel.

Available today: `HOST_PANEL_CAPABILITIES.terminal` (`brucede.terminal`) — the
host's native terminal, the same widget the built-in `Terminal: New Terminal`
command creates. New capabilities are added host-side; a plugin cannot define one.

## Services and events

One registry per side (renderer, backend), shared across plugins and keyed by
owner. Use `WORKSPACE_SERVICE_IDS` / `WORKSPACE_EVENT_IDS` from
`@brucede/plugin-api`; never invent duplicate ids.

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
   down the fiber, but it cannot see raw Node handles.
4. **Keep frontend and backend split.** Node APIs only in `src/backend`.
5. **Never import Theia internals to fake host UI.** If you need a terminal or
   another native surface, adopt a host capability. Bundling `@theia/*` or
   `xterm` into a plugin produces duplicate containers and widgets the shell
   cannot adopt — the bundler allowlist will not link them anyway.
6. **Build real functionality.** No test-only or placeholder plugins; a scaffold
   must exercise the real contract and then be completed.
7. **Never promise code unload.** Native ESM module records may stay cached;
   reload/restart is the answer when a module cannot be replaced safely.

## Checklist before you finish

- [ ] `plugin.json` valid: namespaced id, semver, `apiVersion: 1`, existing
      bundles under `dist/`
- [ ] `npm run build:plugins` succeeds; `dist/` not committed
- [ ] plugin appears in `Plugins: Open Plugin Manager` with no diagnostics
- [ ] its open command docks a panel into the shared main area
- [ ] native panels go through `registerHostPanel`, not a bundled Theia copy
- [ ] disabling it closes every panel it opened and leaves no orphan commands
- [ ] reopening the app restores panels the user left open
- [ ] no host files modified
