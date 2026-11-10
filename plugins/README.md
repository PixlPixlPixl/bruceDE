# Native plugins

Each child folder is a self-contained feature package. A plugin owns its manifest, package metadata, frontend/backend source, assets, and built ESM bundles. Development copies live in this repository; user-installed copies live in `~/.brucede/plugins`.

All plugins are trusted native code. Frontend code runs in the normal Theia renderer and backend code in the normal Node backend. There is no plugin sandbox or per-plugin worker. The plugin manager displays and requires acceptance of the full-system-access warning before enabling third-party plugins.

## Structure

```text
plugins/<plugin-id>/
  plugin.json          manifest validated by the host before any import
  package.json         workspace metadata
  src/frontend/index.tsx   renderer entrypoint exporting activate(api)
  src/backend/index.ts     Node backend entrypoint exporting activate(api)
  dist/frontend.js         built ESM bundle (git-ignored)
  dist/backend.js          built ESM bundle (git-ignored)
```

`plugin.json` is the source of truth for discovery. Build a plugin with:

```bash
node packages/plugin-build/build.mjs plugins/<plugin-id>
# or every plugin at once
npm run build:plugins
```

## The runtime contract

`activate(api)` receives a typed `FrontendPluginAPI` or `BackendPluginAPI`. Everything registered through it is owned by the plugin and disposed when the plugin unloads:

- `api.panels.register({ id, title, createWidget })` — registers a panel **type**. `createWidget` receives `(instanceId, host)` where `host.React`, `host.widgets`, and `host.createReactWidget` are the host's own instances. Do not import React or Lumino directly: use `host` so widgets are the same classes the shell docks.
- `api.panels.open(panelId)` / `api.panels.close(instanceId)` — opens/closes a panel in the shared main area. The host closes every instance a plugin opened when it unloads.
- `api.commands.register({ id, title, execute })` — registers a Theia command.
- `api.services.provide/get/has` — shared, cross-plugin services.
- `api.events.on/emit` — typed, cross-plugin events.
- `api.onDispose(fn)` — extra cleanup.

Returning a disposer from `activate` is optional; the host disposes everything the API registered regardless.

Frontend bundles may also import these host modules directly; the bundler rewrites them to the host's instances at load time: `react`, `react-dom`, `@lumino/widgets`, `@lumino/signaling`, `@lumino/domutils`, `@lumino/coreutils`, `@theia/core/lib/browser`, `@theia/core/lib/common`, and `@theia/core/lib/browser/widgets/react-widget`. The canonical list lives in `workspace-core/src/common/plugin-host-protocol.ts`.

## Manifest

```json
{
  "id": "bruce.terminal",
  "name": "Terminal",
  "version": "0.1.0",
  "apiVersion": 1,
  "entrypoints": { "frontend": "./dist/frontend.js", "backend": "./dist/backend.js" },
  "dependencies": { "bruce.workspace": "^0.1.0" },
  "contributes": { "panels": [{ "id": "terminal.main", "title": "Terminal" }] }
}
```

`id` must be a lower-case namespaced identifier; `apiVersion` must match the host's supported version; entrypoints must be relative, must not escape the plugin folder, and must point at a `.js`/`.mjs` bundle.

## Current plugins

The four bundled plugins are scaffolds: each registers a real panel type and open command through this runtime so the contract is exercised end to end. Their actual feature work (terminal backend, agent session, filesystem listing, Git status) is the next step.

## Trust

Built-in plugins ship with BruceDE and are trusted by definition. Any plugin discovered under `~/.brucede/plugins` is third-party code with full system access and is disabled until the user accepts the confirmation dialog in the plugin manager.
