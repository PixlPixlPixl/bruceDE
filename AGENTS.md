# BruceDE — Agent Guide

## Goal

BruceDE is a plugin-first desktop workspace, not an IDE with a fixed layout. The initial workspace is an empty, full-window docking canvas. No editor, sidebar, terminal, chat, file tree, Git view, toolbar, or other feature opens by default. Users choose which panels to open and arrange them with nested horizontal/vertical splits, tabs, drag/drop, and resizing.

## Trust model

All plugins are **trusted native code**. Frontend modules run directly in the Theia renderer; backend modules run directly in Theia's normal Node backend. There is no per-plugin iframe sandbox, VM, worker, subprocess, or restricted plugin mode. Backend plugins can access files, spawn processes, use the network, and exercise the host's normal OS privileges. The plugin manager must clearly warn users before they install/enable third-party plugins and require an explicit trust decision. This warning is disclosure, not a security boundary. The only execution split is Theia's ordinary frontend/backend architecture.

## Architecture

- `electron-app/`, `browser-app/`: Theia application targets. Electron is the primary desktop target.
- `workspace-core/`: Permanent host infrastructure only: blank canvas, Lumino docking, panel ownership/placement, layout persistence, curated host panel capabilities, and host-to-plugin adapters. Do not put product features here.
- `packages/plugin-api/`: Versioned, stable TypeScript contracts exposed to plugin authors. Keep Cordis and Theia implementation details behind this API where practical.
- `packages/plugin-runtime/`: Cordis contexts/Fibers and the Cordis plugin loader. Frontend and backend both run Cordis core; a backend entrypoint is imported from disk with a dynamic `import()` of a validated `file://` URL, and `@brucede/plugin-runtime/loader` exposes the Cordis `Loader` for resolution work that needs it. Cordis owns activation, dependency ordering, service/event lifecycle, and disposal.
- `packages/ui-kit/`: Optional shared CSS tokens and reusable UI primitives. It must not constrain plugin authors; custom React/TSX, CSS, SVG, canvas, and native Theia widgets are allowed.
- `plugins/<plugin-id>/`: One self-contained folder/package per feature. Each owns its manifest, package metadata, frontend/backend source, assets, and built bundles. Initial feature folders: terminal, agent-chat, file-browser, and git. Agent instructions for creating one: [plugins/AGENTS.md](./plugins/AGENTS.md).

## Plugin package and loading flow

1. Discover `plugin.json` in the built-in `plugins/` directory and the user plugin directory.
2. Validate plugin ID, version, API version, entrypoints, and declared service dependencies. IDs are globally unique and namespaced (for example, `bruce.git`).
3. Resolve plugin dependencies through Cordis. Missing dependencies or failed activation should be reported without silently opening a default workspace.
4. Import the frontend ESM bundle into the existing renderer and the backend ESM bundle into the existing Node backend. These are normal host-context imports, not isolated runtimes.
5. Adapt each module's `activate(api)` entrypoint into a Cordis-managed plugin Fiber. Contributions (panels, services, commands, listeners, timers, watchers) must be registered through disposable effects.
6. When disabled/uninstalled, dispose the Fiber, unregister its services/events/commands, close every panel instance the plugin owns, and release watchers/timers/processes it started. Resources the host created through a host panel capability stay host-owned: unloading a plugin withdraws its contributions, it does not destroy user state the host has taken responsibility for. Closing a panel is not unloading its plugin.
7. Cordis disposal cleans plugin resources, but native ESM module records may remain cached. Do not promise true code-unload or safe in-place binary replacement; use reload/restart when a module cannot be replaced safely.

## Plugin communication

- Use **services** for callable capabilities and durable shared state (for example, `workspace.resources`, `workspace.selection`, `git.repository`, `agent.sessions`).
- Use **typed events** for notifications (for example, `workspace/selection-changed`, `git/changes-updated`).
- Put cross-plugin data contracts in `plugin-api`; use stable IDs and URI-based resource identities.
- Plugins must not import another plugin's implementation. File Browser and Git communicate through shared resource/selection services and events, not direct imports.
- Frontend/backend communication crosses Theia's existing RPC boundary. Do not add another per-plugin process or sandbox.
- Services and events are scoped per side: renderer plugins share one registry, backend plugins share another. A renderer plugin reaches a backend plugin's service through `api.services.remote` (the host's service bridge), not by opening its own channel.

## Stack and conventions

- TypeScript for logic/services; TSX + React for most panel UIs; CSS for styling and animation.
- Use the host's React runtime; do not bundle a private React copy into each plugin.
- Use native Theia/Lumino widgets for dockable panels. A webview may render web content inside a panel, but it is not a plugin isolation mechanism.
- Native host functionality reaches plugins only through curated **host panel capabilities** (`brucede.terminal`). Capability ids are stable contracts, never module paths or Theia class names. Never expose the DI container, `WidgetManager`, host services such as `TerminalService`, raw widget instances, or a general-purpose widget factory to plugins.
- Every path that opens the same kind of native panel must use the same host code. Do not leave a built-in command pointing at a region the canvas does not have.
- Capability factories are contributed by host Theia integrations and live for the host's lifetime; a plugin only requests a panel. Exactly one component restores a given widget — the workspace plugin-panel mechanism for plugin-built panels, the original Theia factory for host-capability panels. Never register the same widget under both.
- Plugin entrypoints are ESM bundles. Keep frontend and backend entrypoints separate; only backend code may rely on Node APIs.
- Keep Cordis internal to `plugin-runtime`; plugin authors consume `@brucede/plugin-api`.
- Plugin registration must not prescribe a dock location. Only the user or an explicit user action chooses placement.
- Do not create test-only feature plugins. Early plugins should implement real basic functionality.
- Ship no demo panels, demo commands or placeholder widgets in the host either. If a surface exists in the UI it must be a real implementation.
- The application defaults to the dark theme. Host and plugin styling uses the `--theia-*` CSS variables; hardcoded light colors are a bug.

## Direction

Build in this order: stable manifest and API contracts; Cordis runtime and native ESM loading; panel ownership and deterministic disposal; typed service/event registry; settings and plugin manager with explicit trust warning; then real terminal, agent-chat, file-browser, and Git plugins. Persist user layouts independently of plugin installation. Keep the startup canvas empty unless the user explicitly restores a saved layout.
