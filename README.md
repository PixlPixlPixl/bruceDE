# Icebox

Icebox is a plugin-first Theia desktop workspace. The initial workspace is an empty docking canvas; users install/open feature panels and decide how they are arranged. The host provides docking, plugin lifecycle, shared APIs, and platform integration—not a prescribed IDE layout.

## Development

```bash
npm ci                      # also compiles @icebox/plugin-api, @icebox/plugin-runtime and workspace-core
npm run build:electron      # plugin bundles, then the app
npm run start:electron
```

The browser target listens on `127.0.0.1:3000` by default. The start scripts end
with `--`, so everything after `npm run start:browser --` reaches Theia's own
`start` command unchanged:

```bash
npm run start:browser                                    # http://localhost:3000
npm run start:browser -- --port 8080                     # http://localhost:8080
npm run start:browser -- --hostname 0.0.0.0 --port 8080  # every interface
npm run start:browser -- --hostname 192.168.1.20         # one interface
```

`--hostname` is Theia's flag for the listen address (its help text calls it "the
allowed hostname for connections", but it is passed straight to
`server.listen(port, hostname)`). There is no `--host`: an unknown flag is ignored
by Theia, so `--host 0.0.0.0` leaves the server on `localhost` and nothing outside
the machine can connect. The electron target forwards the same arguments
(`npm run start:electron -- --port 3001`).

`npm ci`/`npm install` runs the root `postinstall`, which compiles the local
packages in order (`@icebox/plugin-api` → `@icebox/plugin-runtime` →
`workspace-core`). They are workspace packages, not published to npm, so their
`lib/` output is not committed; without that step TypeScript cannot resolve
`@icebox/*` and reports `TS2307: Cannot find module '@icebox/plugin-api' or its
corresponding type declarations`.

If you installed with `--ignore-scripts`, build them once by hand:

```bash
npm run build:workspace-core
```

### If `build:electron` says `Cannot find module '../build/Debug/ffmpeg.node'`

Theia's Electron build checks Electron's bundled ffmpeg library with a small
native addon (`@theia/ffmpeg/build/Release/ffmpeg.node`). The addon is built by
the package's install script — `node-gyp rebuild`, synthesised from its
`binding.gyp` — so an install that skipped dependency scripts (for example
`--ignore-scripts`, or an npm `allowScripts` policy that does not cover
`@theia/ffmpeg`) leaves it missing. The install still succeeds, and the build
then fails *after* printing harmless ffmpeg cache messages, which makes the
message look unrelated:

```text
Found cached ffmpeg library. Hashes are equal, not replacing the ffmpeg library.
Error: Cannot find module '../build/Debug/ffmpeg.node'
```

The Electron build now builds the addon itself when it is missing
(`electron-app` runs `native:ffmpeg` → `scripts/ensure-ffmpeg-addon.mjs` before
`theia build`), so `npm run build:electron` repairs this case. It compiles the
addon from C with node-gyp, which needs python3, make and a C compiler
(`base-devel` on Arch, `build-essential` on Debian, Xcode CLT on macOS, MSVC
Build Tools on Windows); on Linux it falls back to the system Node headers in
`/usr/include/node` if it cannot download them. If the addon still cannot be
built, `npm rebuild @theia/ffmpeg` (with install scripts allowed) does the same
job from npm's side.

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

1. **Discovery** — the backend scans the built-in `plugins/` folder and `~/.icebox/plugins`, validating every `plugin.json` before importing anything (`workspace-core/src/node/plugin-discovery.ts`).
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
