# Agent runtime and the AG-UI vocabulary

Design note for the `feat/agent-runtime` branch. It records what has landed,
what the split is, and the traps that must be closed in the same change — so the
work resumes without rediscovering them.

## The shape

```text
plugin-api            AG-UI event vocabulary + AgentRuntimeService + transcript folding
agent-orchestrator    owns connections and processes; adapters: acp.ts, pi-rpc.ts, agui.ts
                      provides `agent.runtime`
agent-chat            panel + `agent.sessions` facade over `agent.runtime`
plugins/agent-*.json  one data-only agent descriptor each (`contributes.agents`)
```

Why this split: a second chat panel (a different UI, a headless consumer, a CLI)
needs the protocols, not the panel. The orchestrator is the only thing that
spawns a process or holds a resume handle; panels are projections of runtime
state and render `AgentRuntimeState.events`.

AG-UI is used as the **vocabulary**, not as a transport: the runtime emits AG-UI
event objects in process (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`,
`CUSTOM`, `STATE_SNAPSHOT`/`STATE_DELTA`). No HTTP hop and no SSE parsing is
involved for a local CLI. Remote AG-UI servers still speak the real protocol, and
their adapter emits the same objects — which is why one panel can render both.

Protocol-specific extras stay on the capability surface (`AgentRuntimeService`
methods: `searchModels`, `selectThinking`, `runShell`, `commands`), never on the
event stream: AG-UI has no model list and no token accounting, so folding
capabilities into events would silently drop what ACP and Pi report.

## What landed on this branch

- `packages/plugin-api`:
  - `WORKSPACE_SERVICE_IDS.agentRuntime` (`agent.runtime`).
  - The AG-UI event union `AgUiEvent`, `ChatEntry`, `AgentTranscript`, plus
    `applyAgUiEvents()` — folding is shared, so every consumer renders the same
    conversation from the same stream.
  - `AgentRuntimeService` / `AgentRuntimeState`. `state(sessionId, since?)`
    returns only events newer than an opaque cursor, so a poll is incremental
    rather than a transcript resend.
  - Tolerant folding: unknown or malformed events leave the transcript unchanged.
    This is the mechanism behind "if AG-UI misbehaves the panel still works".
- Agent configuration is already plugin data (`contributes.agents`), landed on
  `main`.

Nothing is removed from `agent-chat` yet; the branch is additive and the app
behaves exactly as on `main`.

## Remaining steps, in order

0. ~~**Harness.**~~ Done: `scripts/verify-agent-sessions.mjs` (`npm run
   verify:agent-sessions`). It runs the built backend head-lessly with a fake
   `BackendPluginAPI` — plugin-declared discovery, an AG-UI run through an SSE
   stub, the dead-endpoint fallback, a real CLI session and release. It is the
   net the split has to fall into: every assertion below must still pass when
   `agent.runtime` replaces `agent.sessions` as its target, and a provider outage
   is reported as skipped rather than failed so an external hiccup never masks a
   regression.
1. **`plugins/agent-orchestrator` exists.** Done in two steps so each commit is
   verifiable: the relocation (adapters, session machinery, `agent.sessions`
   provided from the orchestrator; agent-chat is now a renderer-only plugin that
   declares the dependency) and, next, the surface change below.

   Then move `acp.ts`, `pi-rpc.ts`,
   `agui.ts`, `spawn.ts` and the session machinery out of
   `plugins/agent-chat/src/backend/index.ts` (done). In the runtime, `pushEntry` is the
   single choke point every protocol mapping already goes through, so it becomes
   the place that records an `AgUiEvent` (role mapping: `agent` →
   `TEXT_MESSAGE_START`/`CONTENT`/`END`, `tool` → `TOOL_CALL_RESULT`, `user` →
   `CUSTOM icebox/user-message`, `system` → `CUSTOM icebox/system`). Drop the
   entry array: keep `title` (first user prompt) for session lists and the
   bounded event log with a monotonic cursor.
2. **Surface change and facade.** The orchestrator starts providing
   `agent.runtime` (events + cursor) instead of `agent.sessions`; a new
   `agent-chat/src/backend/index.ts` becomes the facade. Then:
   **`agent-chat/src/backend/index.ts` becomes a facade.** It keeps
   `agent.sessions` (Projects polls summaries through it) and delegates to
   `agent.runtime`, folding events with `applyAgUiEvents` so the existing
   `AgentState.entries` contract still holds for the panel. Keep `/new`,
   mid-turn and shell semantics in the runtime, where capabilities are known.
3. **Manifests.** `agent-chat` declares `"dependencies": { "icebox.agent-orchestrator": "^0.1.0" }`; the orchestrator declares `provides`-style metadata in `contributes.services: ["agent.runtime"]`.
4. **Fill in the fixture harness** before step 1 lands, not after.

## Traps that must be closed in the same change

- **Protocol ids are a closed roster.** `isAgentProtocol` in `plugin-api` is what
  Projects validates stored handles with. When a protocol becomes a plugin, both
  the predicate and the label map must become driver-supplied (opaque id +
  displayed name), or handles from an unknown protocol are silently dropped and
  every such session stops resuming.
- **Activation order.** `activateEnabledBackendPlugins` iterates
  `manifest.id`-sorted plugins, so `agent-chat` (a) loads before
  `agent-orchestrator` (o) and its `api.services.get('agent.runtime')` throws at
  activation. Either enumerate lazily (`has()` then `get()` per call) or add
  `api.services.list(prefix)` and topological activation. Lazy enumeration is the
  smaller change and matches how `workspace.plugins` is consumed.
- **Unload must dispose connections.** A driver owns child processes; disabling
  the orchestrator plugin must kill them (Cordis disposes the fiber, not raw
  Node handles). Otherwise a toggle leaks `pi`/`gemini` processes.
- **Degraded state, not an error.** With the orchestrator disabled, the panel
  shows "no agent runtime enabled" in the picker and keeps its transcript — the
  facade must catch a missing provider rather than throw through `state()`.
- **No HTTP locally.** Do not proxy a local CLI through a loopback SSE server to
  "use AG-UI properly": it adds a process, a port and a failure mode for no
  capability. The vocabulary is what is being reused.
