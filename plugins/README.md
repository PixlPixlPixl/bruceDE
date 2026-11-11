# Native plugins

Agent instructions for adding a plugin live in [AGENTS.md](./AGENTS.md). Read it
before writing code here; it covers the manifest, build, `activate(api)` contract,
and the rules that keep a plugin self-contained.

Each child folder is a self-contained feature package. A plugin owns its manifest, package metadata, frontend/backend source, assets, and built ESM bundles. Development copies live in this repository; user-installed copies live in `~/.icebox/plugins`.

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
- `api.panels.registerHostPanel({ id, title, capabilityId })` — registers a panel the host builds, for native functionality you must not reimplement. `api.panels.hasHostCapability(id)` reports whether this build exposes it. Capability ids (`icebox.terminal`) are stable host contracts, never import paths or Theia class names; you never receive a raw host widget or the DI container.
- `api.services.provide/get/has` — shared services on the plugin's own side of the boundary. One registry per side, keyed by owner; a plugin can consume another plugin's service and unloading the provider removes exactly its own entries.
- `api.services.remote<T>(serviceId)` — a renderer plugin's typed view of a service a **backend** plugin provided. Each method call becomes one RPC call over Theia's existing channel, so arguments and results must be JSON-serializable. Calling it from a backend plugin throws; backend plugins use `get` in-process.
- `api.events.on/emit` — typed events, also shared per side.
- `api.onDispose(fn)` — extra cleanup.

Returning a disposer from `activate` is optional; the host disposes everything the API registered regardless.

## Host services

Before any plugin activates, the host provides `workspace.resources` and `workspace.selection` under the `icebox.workspace` owner. Use them instead of reimplementing them:

```ts
const resources = api.services.get<WorkspaceResourcesService>(WORKSPACE_SERVICE_IDS.resources);
const uri = resources.fromPath('/home/user/project/src/app.ts');
const stat = await resources.stat(uri);

const selection = api.services.get<WorkspaceSelectionService>(WORKSPACE_SERVICE_IDS.selection);
selection.set({ uri, ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }] });
api.events.on(WORKSPACE_EVENT_IDS.selectionChanged, next => { /* react */ });
```

Feature plugins provide the rest: `git.repository` and `agent.sessions` are reserved ids that the bundled feature plugins will fill in.

## Layout and restart behavior

Panels are opened into the shared main DockPanel and persisted by the host's layout restorer. Opening a panel is a user action; `activate` should register surfaces and commands, not open panels. When a plugin is disabled, the host closes every panel it opened and stops tracking them.

Frontend bundles may also import these host modules directly; the bundler rewrites them to the host's instances at load time: `react`, `react-dom`, `@lumino/widgets`, `@lumino/signaling`, `@lumino/domutils`, `@lumino/coreutils`, `@theia/core/lib/browser`, `@theia/core/lib/common`, and `@theia/core/lib/browser/widgets/react-widget`. The canonical list lives in `workspace-core/src/common/plugin-host-protocol.ts`.

## Manifest

```json
{
  "id": "icebox.terminal",
  "name": "Terminal",
  "version": "0.1.0",
  "apiVersion": 1,
  "entrypoints": { "frontend": "./dist/frontend.js", "backend": "./dist/backend.js" },
  "dependencies": { "icebox.workspace": "^0.1.0" },
  "contributes": { "panels": [{ "id": "terminal.main", "title": "Terminal" }] }
}
```

`id` must be a lower-case namespaced identifier; `apiVersion` must match the host's supported version; entrypoints must be relative, must not escape the plugin folder, and must point at a `.js`/`.mjs` bundle.

## Current plugins

- **File Browser** (`icebox.file-browser`) — folder listing over the host's
  `workspace.resources` service, publishes selections through
  `workspace.selection`. Its backend half provides `files.roots`, which starts at
  the user's home folder (`~`) rather than the directory the app was launched
  from. The header has back/forward/up buttons over a navigation history, shows
  the current folder with the home prefix shortened to `~`, and carry icon-only
  Refresh (`codicon codicon-refresh`, `aria-label="Refresh"`) instead of text.
  Clicking a folder descends into it; clicking a file selects it.
- **Git** (`icebox.git`) — backend half runs `git status --porcelain=v2` and
  `git diff HEAD --numstat -z` in the user's work tree and provides
  `git.repository`; the panel reads it through `api.services.remote` and
  republishes `git/changes-updated` in the renderer. Each file carries its own
  `+N`/`-M` line counts against `HEAD` (staged and unstaged together), and the
  rows are coloured by what the change means — added, modified, deleted, renamed,
  conflicted, untracked — using the `--theia-gitDecoration-*` tokens with
  fallbacks, because this build ships no Git extension to define them.
  Untracked and binary files show no counts rather than a fabricated zero.
  The header box is the same `6px 10px` as the other plugin panels, so the
  separator line matches when the panels sit side by side.
- **Agent Chat** (`icebox.agent-chat`) — backend half drives an installed agent
  CLI and provides `agent.sessions`. Two wire protocols are supported, because
  the ecosystem is not uniform:
  - `acp` — the Agent Client Protocol (JSON-RPC over stdio), used by Gemini CLI,
    Claude Code and other ACP agents;
  - `pi-rpc` — Pi's own JSONL command/event protocol (`pi --mode rpc`); Pi has
    no ACP mode.

  Each chat tab is one session: the backend keys its process and transcript by
  the panel instance id, and the agent travels in the panel state, so restoring a
  layout restores the tabs. A caller that needs to address the session later
  (Projects) can pass its own logical `sessionId` in the panel state instead.
  Every session exposes its agent's native handle (`AgentState.resume`): Pi's
  `sessionId`/`sessionFile` from `get_state`, ACP's `sessionId`. Passing that
  handle back in `openSession(…, { resume })` continues the same agent-side
  conversation through the agent's own mechanism — `--session <file>` for Pi,
  `session/load` for ACP — and rebuilds the transcript from the agent
  (`get_messages` for Pi, replayed `session/update` notifications for ACP), so a
  resume does not start a new session or discard the provider's prompt cache.
  A chat opened with a `cwd` persists its session so it can be resumed from any
  directory; a plain chat keeps `--no-session` and stays ephemeral. The header has a `+` button instead of a permanent
  agent list: it opens a picker with installed agents on top (full colour,
  alphabetical) and the supported-but-missing ones below, dimmed and disabled.
  Choosing an agent opens a **sibling tab** next to the current chat
  (`tab-after`), even when it is the agent this tab already talks to — `+` means
  "another chat", so it never reconfigures the one on screen. The running
  session keeps its transcript and its process.

  The composer footer shows what the agent reports about itself: the current
  model and thinking level (click it to switch, from the models and levels the
  agent actually advertises), context-window usage with the raw token counts in
  the tooltip, and the cache hit rate (`cacheRead / (input + cacheRead)` over the
  session). Pi supplies these through `get_state`, `get_session_stats`,
  `get_available_models`, `get_available_thinking_levels`, `set_model` and
  `set_thinking_level`; ACP agents supply models and commands only when they
  advertise them, so nothing is offered that the agent cannot do. Pi lists
  thousands of models, so the catalogue is fetched on demand by a filtered
  `searchModels` call instead of travelling with every state poll.

  The composer wraps its content as it is typed and stops growing at a fixed
  height, where it scrolls, so a long prompt never pushes the transcript off
  screen. The model menu takes keystrokes as a filter (its search field is
  focused as soon as it opens), and a tab that is still starting an agent says
  "Connecting to agent..." rather than "Agent is working...".

  There is no Reset and no Cancel button. A fresh session is the agent's own
  `/new` (Pi's `new_session` RPC command, intercepted by the backend and skipped
  for ACP, where `/new` is ordinary prompt text) or a new tab from `+`.

  A message sent while the agent is working is never dropped: it follows the
  protocol's own mid-turn behaviour. Pi steers it into the running turn
  (`prompt` with `streamingBehavior: 'steer'`), so the agent sees it after the
  current assistant turn; ACP has no steering channel, so the backend keeps a
  client-side queue and sends the message when the current turn ends. A steer the
  agent refuses falls back to that queue instead of vanishing, and the button
  names what will happen — `Steer` or `Queue` instead of `Send`.

  Typing `/` offers the agent's own commands (`get_commands` in Pi, the
  `available_commands_update` notification in ACP), `@` offers files from the
  host's `workspace.resources` service, and `!` runs a shell command through the
  agent. `@path` mentions are inlined by the plugin — RPC mode does not expand
  `@file` the way the agent's interactive mode does — and `!` is only offered
  when the protocol has a shell passthrough (Pi's `bash` command; ACP agents in
  this plugin do not).

  Agents come from `ICEBOX_AGENTS` (JSON array of
  `{ id, name, protocol?, command, args? }`, `protocol` defaults to `acp`;
  `ICEBOX_ACP_AGENTS` is still accepted under its old name). Without
  configuration, the built-in catalog is a **detection list, not a roster**: Pi,
  Gemini CLI, Claude Code (ACP) and OpenCode are probed on `PATH`, and only the
  ones actually installed are offered — the panel never shows a dead entry for an
  agent that is not there. The panel polls the service because the host cannot
  push backend events across the RPC boundary.

  Agent executables are resolved to a real path first: npm shims on Windows are
  `.cmd` files that cannot be passed to `CreateProcess`, so they are launched
  through the command processor explicitly while POSIX agents are spawned
  directly.
- **Projects** (`icebox.projects`) — durable project folders with their agent
  sessions. A project is a folder the user adds through the host's folder picker
  (`workspace.dialogs`); `+` on a project starts a chat in that folder through
  the agent-chat launcher service (`agent.chat`), so the chat stays owned by
  agent-chat. Sessions are stored in `~/.icebox/projects.json` (or
  `$ICEBOX_STATE_DIR/projects.json`) with the agent's native resume handle, and
  are adopted automatically when a chat was opened in a project folder from
  elsewhere. Resume reopens the same logical session id with that handle, which
  is the agent's own resume path rather than a fresh session. Projects and
  sessions can be archived (kept, out of the way) or deleted; deleting a live
  session releases its agent. The panel polls `projects.refresh()` since the host
  has no renderer push channel. Its header uses the same `6px` + 22px control +
  `6px` box as the other panels, so the separator lines align when they sit side
  by side.
- **Terminal** (`icebox.terminal`) — adopts the host's `icebox.terminal`
  capability through `api.panels.registerHostPanel`, so the widget is created,
  rendered, persisted and disposed by the host's own terminal code. The plugin
  bundle contains no Theia or xterm code. The built-in
  `Open Terminal` command reaches the same creation path and the same
  main-area placement (see `workspace-core/src/browser/canvas-terminal.ts`).

## Trust

Built-in plugins ship with Icebox and are trusted by definition. Any plugin discovered under `~/.icebox/plugins` is third-party code with full system access and is disabled until the user accepts the confirmation dialog in the plugin manager.
