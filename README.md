# BruceDE

BruceDE is a plugin-first Theia desktop workspace. The initial workspace is an empty docking canvas; users install/open feature panels and decide how they are arranged. The host provides docking, plugin lifecycle, shared APIs, and platform integration—not a prescribed IDE layout.

## Development

```bash
npm ci                      # also compiles @brucede/plugin-api, @brucede/plugin-runtime and workspace-core
npm run build:electron      # plugin bundles, then the app
npm run start:electron
```

The browser target binds `127.0.0.1:3000` by default. Arguments after `--` reach
the launcher, so it can be exposed on another interface or port:

```bash
npm run start:browser                                  # http://localhost:3000
npm run start:browser -- --port 8080                   # http://localhost:8080
npm run start:browser -- --host 0.0.0.0 --port 8080    # reachable from the network
```

`--host` is accepted here and mapped to Theia's `--hostname` (which is what
actually sets the bind address); `--port` is passed through. Any other option is
forwarded unchanged to `theia start` (`--ssl`, `--log-level`, …), and the
electron target accepts the same flags (`npm run start:electron -- --port 3001`).

`npm ci`/`npm install` runs the root `postinstall`, which compiles the local
packages in order (`@brucede/plugin-api` → `@brucede/plugin-runtime` →
`workspace-core`). They are workspace packages, not published to npm, so their
`lib/` output is not committed; without that step TypeScript cannot resolve
`@brucede/*` and reports `TS2307: Cannot find module '@brucede/plugin-api' or its
corresponding type declarations`.

If you installed with `--ignore-scripts`, build them once by hand:

```bash
npm run build:workspace-core
```

Every script that runs during install or build calls its tool entrypoint through
`node` directly (`node node_modules/@theia/cli/bin/theia.js build`) instead of
going through the `node_modules/.bin` wrapper. Those wrappers are `.cmd` files on
Windows whose last line is `"%_prog%" …`, and on a host where `node` is itself a
shim, `cmd.exe` resolves that quoted name literally and fails with
`'"node"' is not recognized as an internal or external command`, aborting
`npm install`. Plain `node` is what npm itself uses, so it always resolves.

The application is pinned to Theia 1.77.0. Cordis is the native-plugin lifecycle engine. Plugins are trusted code, not sandboxed: read [AGENTS.md](./AGENTS.md) before developing or installing plugins.

## Plugin runtime

The runtime is implemented and covers the full contract plugins rely on:

1. **Discovery** — the backend scans the built-in `plugins/` folder and `~/.brucede/plugins`, validating every `plugin.json` before importing anything (`workspace-core/src/node/plugin-discovery.ts`).
2. **Frontend ESM loading** — bundles are served from the backend (same-origin `fetch` in the browser target) or handed over the existing RPC channel when the renderer runs from a `file://` origin (Electron), then dynamically imported. Shared host modules (`react`, `@lumino/widgets`, Theia browser/common) resolve to the host's own instances, so plugin widgets are real Lumino widgets (`workspace-core/src/browser/plugin/`).
3. **Cordis activation/disposal** — each plugin runs in its own Cordis fiber; unloading drains its disposers in reverse order (`packages/plugin-runtime/src/manager.ts`).
4. **Panel ownership + layout persistence** — every panel instance is created through one host `WidgetManager` factory, so panels are tracked by owner *and* persisted by Theia's layout restorer. A plugin unload closes the panels it opened; a restart re-opens the ones the user left open (`workspace-core/src/browser/workspace-panel-factory.ts`).
5. **Shared services, events and RPC** — services and typed events are shared by owner on both sides of the boundary, the host publishes `workspace.resources` and `workspace.selection`, and `api.services.remote` reaches backend-plugin services over Theia's existing RPC channel.
6. **Plugin manager + trust warning** — third-party plugins require an explicit full-system-access confirmation before activation; built-in plugins are trusted by virtue of shipping with the app.

Built-in plugins are enabled by default so their panel types and commands are available; disabling one closes its panels and removes its contributions. Third-party plugins stay off until the user accepts the trust dialog. Either way the startup canvas is empty — enabled plugins register capabilities, they do not open panels.

### Writing a plugin

See [plugins/README.md](./plugins/README.md). Each plugin folder has a `plugin.json`, a `src/frontend` and/or `src/backend` entrypoint, and builds with `node packages/plugin-build/build.mjs <pluginDir>` (or `npm run build:plugins` for every plugin).

## Repository layout

- `workspace-core/`: blank canvas, docking, panel registry + widget factory, layout persistence, host services, plugin host (discovery, RPC bridge, frontend/backend loaders, manager).
- `packages/plugin-api/`: stable plugin author API contracts.
- `packages/plugin-runtime/`: Cordis plugin manager, manifest validation, disposal helpers.
- `packages/plugin-build/`: esbuild bundler for plugin entrypoints.
- `packages/ui-kit/`: optional shared visual tokens/primitives.
- `plugins/`: self-contained feature plugin packages (terminal, agent-chat, file-browser, Git).
- `electron-app/` and `browser-app/`: Theia application targets.

See [AGENTS.md](./AGENTS.md) for the product goal, native trust model, plugin loading flow, communication rules, and implementation direction.
