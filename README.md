# BruceDE

BruceDE is a plugin-first Theia desktop workspace. The initial workspace is an empty docking canvas; users install/open feature panels and decide how they are arranged. The host provides docking, plugin lifecycle, shared APIs, and platform integration—not a prescribed IDE layout.

## Development

```bash
npm ci
npm run build:electron      # builds plugin API/runtime, workspace-core, plugin bundles, then the app
npm run start:electron
```

The application is pinned to Theia 1.77.0. Cordis is the native-plugin lifecycle engine. Plugins are trusted code, not sandboxed: read [AGENTS.md](./AGENTS.md) before developing or installing plugins.

## Plugin runtime

The runtime is implemented and covers the full contract plugins rely on:

1. **Discovery** — the backend scans the built-in `plugins/` folder and `~/.brucede/plugins`, validating every `plugin.json` before importing anything (`workspace-core/src/node/plugin-discovery.ts`).
2. **Frontend ESM loading** — bundles are served from the backend and dynamically imported in the renderer. Shared host modules (`react`, `@lumino/widgets`, Theia browser/common) resolve to the host's own instances, so plugin widgets are real Lumino widgets (`workspace-core/src/browser/plugin/`).
3. **Cordis activation/disposal** — each plugin runs in its own Cordis fiber; unloading drains its disposers in reverse order (`packages/plugin-runtime/src/manager.ts`).
4. **Panel ownership** — panels registered by a plugin are tracked by owner and closed automatically when the plugin unloads.
5. **Theia RPC** — trust and enable state, discovery and asset URLs cross the frontend/backend boundary over Theia's existing RPC channel.
6. **Plugin manager + trust warning** — third-party plugins require an explicit full-system-access confirmation before activation; built-in plugins are trusted by virtue of shipping with the app.

Enable plugins from the command palette (`Plugins: Open Plugin Manager`) or the per-plugin enable/disable commands. Nothing is enabled by default, so the startup canvas stays empty.

### Writing a plugin

See [plugins/README.md](./plugins/README.md). Each plugin folder has a `plugin.json`, a `src/frontend` and/or `src/backend` entrypoint, and builds with `node packages/plugin-build/build.mjs <pluginDir>` (or `npm run build:plugins` for every plugin).

## Repository layout

- `workspace-core/`: blank canvas, docking, panel registry, plugin host (discovery, RPC, frontend loader, manager).
- `packages/plugin-api/`: stable plugin author API contracts.
- `packages/plugin-runtime/`: Cordis plugin manager, manifest validation, disposal helpers.
- `packages/plugin-build/`: esbuild bundler for plugin entrypoints.
- `packages/ui-kit/`: optional shared visual tokens/primitives.
- `plugins/`: self-contained feature plugin packages (terminal, agent-chat, file-browser, Git).
- `electron-app/` and `browser-app/`: Theia application targets.

See [AGENTS.md](./AGENTS.md) for the product goal, native trust model, plugin loading flow, communication rules, and implementation direction.
