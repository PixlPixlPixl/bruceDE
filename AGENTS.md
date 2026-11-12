# Icebox — Agent Guide

## Goal

Icebox is a plugin-first desktop workspace, not an IDE with a fixed layout. The initial workspace is an empty, full-window docking canvas. No editor, sidebar, terminal, chat, file tree, Git view, toolbar, or other feature opens by default. Users choose which panels to open and arrange them with nested horizontal/vertical splits, tabs, drag/drop, and resizing.

## Trust model

All plugins are **trusted native code**. Frontend modules run directly in the Theia renderer; backend modules run directly in Theia's normal Node backend. There is no per-plugin iframe sandbox, VM, worker, subprocess, or restricted plugin mode. Backend plugins can access files, spawn processes, use the network, and exercise the host's normal OS privileges. The plugin manager must clearly warn users before they install/enable third-party plugins and require an explicit trust decision. This warning is disclosure, not a security boundary. The only execution split is Theia's ordinary frontend/backend architecture.

## Architecture

- `electron-app/`, `browser-app/`: Theia application targets. Electron is the primary desktop target.
- `workspace-core/`: Permanent host infrastructure only: blank canvas, Lumino docking, panel ownership/placement, layout persistence, curated host panel capabilities, and host-to-plugin adapters. Do not put product features here.
- `packages/plugin-api/`: Versioned, stable TypeScript contracts exposed to plugin authors. Keep Cordis and Theia implementation details behind this API where practical.
- `packages/plugin-runtime/`: Cordis contexts/Fibers and the Cordis plugin loader. Frontend and backend both run Cordis core; a backend entrypoint is imported from disk with a dynamic `import()` of a validated `file://` URL, and `@icebox/plugin-runtime/loader` exposes the Cordis `Loader` for resolution work that needs it. Cordis owns activation, dependency ordering, service/event lifecycle, and disposal.
- `packages/ui-kit/`: Optional shared CSS tokens and reusable UI primitives. It must not constrain plugin authors; custom React/TSX, CSS, SVG, canvas, and native Theia widgets are allowed.
- `plugins/<plugin-id>/`: One self-contained folder/package per feature. Data-only
  agent declarations live one level down, in `plugins/agents/<agent-id>/`. Each owns its manifest, package metadata, frontend/backend source, assets, and built bundles. Initial feature folders: terminal, agent-chat, projects, file-browser, and git. Agent instructions for creating one: [plugins/AGENTS.md](./plugins/AGENTS.md).

## Plugin package and loading flow

1. Discover `plugin.json` in the built-in `plugins/` directory (plus one grouping level,
   e.g. `plugins/agents/`) and the user plugin directory.
2. Validate plugin ID, version, API version, entrypoints, and declared plugin dependencies (ids plus semver ranges). IDs are globally unique and namespaced (for example, `icebox.git`).
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
- Native host functionality reaches plugins only through curated **host panel capabilities** (`icebox.terminal`). Capability ids are stable contracts, never module paths or Theia class names. Never expose the DI container, `WidgetManager`, host services such as `TerminalService`, raw widget instances, or a general-purpose widget factory to plugins.
- Every path that opens the same kind of native panel must use the same host code. Do not leave a built-in command pointing at a region the canvas does not have.
- Capability factories are contributed by host Theia integrations and live for the host's lifetime; a plugin only requests a panel. Exactly one component restores a given widget — the workspace plugin-panel mechanism for plugin-built panels, the original Theia factory for host-capability panels. Never register the same widget under both.
- Plugin entrypoints are ESM bundles. Keep frontend and backend entrypoints separate; only backend code may rely on Node APIs.
- Keep Cordis internal to `plugin-runtime`; plugin authors consume `@icebox/plugin-api`.
- Plugin registration must not prescribe a dock location. Only the user or an explicit user action chooses placement.
- Do not create test-only feature plugins. Early plugins should implement real basic functionality.
- Ship no demo panels, demo commands or placeholder widgets in the host either. If a surface exists in the UI it must be a real implementation.
- F1 is the workspace menu, not a command index. It lists panel commands and the layout commands (`Save Layout`, `Load Layout`) and nothing else, so this is where new UI surfaces must not land by accident: a command becomes searchable only by joining `WorkspacePalette`, which the plugin kernel does for every command a plugin registers. Registering a command is not the same as advertising it — anything that is not a panel open or a layout action belongs in a panel, not in F1.
- Configuration a user can change is plugin data, not compiled-in source. Agent CLIs are declared in a plugin's `contributes.agents` and read through `workspace.plugins`, so adding, disabling or removing an agent is a folder drop or a manager toggle; `ICEBOX_AGENTS` stays as the escape hatch and replaces the catalogue when set. The same rule applies to the next fixed-shape configuration: if the list lives in a consumer's source, the user cannot manage it.
- Agent transports live in `icebox.agent-orchestrator`, never in a panel: it adapts ACP, Pi RPC and AG-UI and normalises them into the AG-UI event vocabulary from `plugin-api` (`agent.runtime`, incremental `since` cursor). A panel folds events with `applyAgUiEvents` and renders them (`agent.sessions`); it must not spawn a process or map a protocol. Capabilities stay service methods, never events, so a protocol with fewer features cannot silently hide another's.
- Agent chat speaks **AG-UI first**, and an agent's own protocol (`acp`, `pi-rpc`) only as the fallback when no AG-UI endpoint answers. No bridge fronts a local CLI with an AG-UI endpoint: Pi has no HTTP transport and the ACP agents are stdio, so every bundled agent legitimately falls back, and an adapter process would add a port and a failure mode without giving the agent anything. AG-UI is for agents that are already HTTP servers; its `CUSTOM`/state events are the channel generative UI would use, so the AG-UI path stays wired and tested even while unused. The choice is made per session and reported, never assumed: `AgentState.protocol` carries what the session actually speaks and the panel labels it next to the agent's name. A new protocol means a new `AgentProtocol` member and `AGENT_PROTOCOL_LABELS` entry in `plugin-api`, an `AgentLink` implementation plus a transcript mapper in the plugin, and a resume path that uses the agent's own mechanism — nothing may display a protocol it is not speaking.
- `install.sh`, `update.sh`, `uninstall.sh`, `start-browser.sh`, `start-electron.sh` and `status.sh` (plus their `.cmd` twins) are one-line wrappers around `scripts/icebox.mjs`. That file owns install order and the up-to-date checks; when a build step, source folder or generated directory is added or renamed, update its fingerprint lists, output checks and cleanup list there rather than teaching it in prose or in a new shell script.
- Install and build scripts invoke tool entrypoints through `node` (`node node_modules/@theia/cli/bin/theia.js build`), never through the `node_modules/.bin` wrappers: those are `.cmd` files on Windows whose `"%_prog%"` line breaks where `node` is itself a shim, aborting `npm install` with `'"node"' is not recognized`.
- A build step that needs a compiled artifact produces it or fails with an actionable message; never assume an install-time script created it. `npm install --ignore-scripts` and npm's `allowScripts` policy silently skip dependency install scripts, so `scripts/ensure-ffmpeg-addon.mjs` builds `@theia/ffmpeg`'s addon before `theia build` instead of letting the build die on `Cannot find module '../build/Debug/ffmpeg.node'`.
- The application defaults to the dark theme. Host and plugin styling uses the `--theia-*` CSS variables; hardcoded light colors are a bug.
- Host CSS is injected by `WorkspaceHostStyles` into a `<style>` element, because workspace-core compiles with plain `tsc` and has no stylesheet pipeline. A host rule exists to correct a specific Theia behaviour (a tooltip swallowing clicks, a stock contribution opening into a missing region), so scope it to that behaviour's class or position and document what it fixes; whole-panel restyling belongs to the plugin that owns the panel.
- User-visible names are Icebox's, never Theia's: window titles, theme names and dialogs carry the product name, while genuine third-party attribution (the extension list in About, a library's own label) stays. Titles are branded after every build by `scripts/brand-generated-html.mjs` because Theia's frontend generator hardcodes the secondary-window title; theme names are rebranded by overriding the theme and icon-theme *listings* in `workspace-branding.ts`, never their ids, so persisted preference values keep working. Adding a themed surface means checking both places rather than writing "Theia" beside the product name. Outside the renderer, `electron-app/package.json` owns the application identity: `productName: "Icebox"` names the window/taskbar entry, the User-Agent and the user-data directory, so changing it relocates user state (`~/.config/Icebox` on Linux) rather than migrating it.

## Direction

That sequence is complete: manifest and API contracts, the Cordis runtime with native ESM loading, panel ownership and deterministic disposal, the typed service/event registry, the plugin manager with its trust warning, and the terminal, agent-chat, projects, file-browser and Git plugins. What remains is breadth rather than foundation — an AG-UI transport plugin for agents that are already HTTP servers, a GenUI renderer driven by the `CUSTOM`/`STATE_*` events the runtime already forwards, and the next fixed-shape configuration that should become plugin data. Two invariants hold throughout: user layouts persist independently of plugin installation, and the startup canvas stays empty unless the user explicitly restores a saved layout.
