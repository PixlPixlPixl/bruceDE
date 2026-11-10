# @brucede/plugin-api

Versioned contracts shared by the host and native plugins. Plugins use these types to contribute panels and communicate through shared services/events.

Keep this package independent of Cordis internals. Additive API changes are preferred; breaking changes require an `apiVersion` change and an explicit compatibility policy.

`apiVersion: 1` exposes:

- `FrontendPluginAPI` — `panels`, `commands`, `ui` (host React/Lumino), `services`, `events`, `origin`, `onDispose`.
- `HOST_PANEL_CAPABILITIES` and `HostPanelRegistration` — curated host capabilities a plugin can adopt through `api.panels.registerHostPanel` (`brucede.terminal` today) instead of importing Theia internals.
- `BackendPluginAPI` — `services`, `events`, `workspace`, `origin`, `onDispose`.
- `ServiceRegistryAPI.remote<T>()` and `RemoteService<T>` — renderer → backend service calls over Theia's RPC channel.
- `WORKSPACE_SERVICE_IDS` / `WORKSPACE_EVENT_IDS` — the stable ids of host and first-party services and events.
- `ResourceUri`, `ResourceSelection`, `ResourceStat`, `WorkspaceResourcesService`, `WorkspaceSelectionService` — the URI-based cross-plugin data contracts.

Reserved but not yet provided by the host: `git.repository` (`WORKSPACE_SERVICE_IDS.gitRepository`), `agent.sessions` (`WORKSPACE_SERVICE_IDS.agentSessions`), and `git/changes-updated` (`WORKSPACE_EVENT_IDS.changesUpdated`). Feature plugins fill these in; the ids are frozen so a plugin can code against them now.

## Per-instance panel state

`PanelOpenOptions.state` is a plain JSON object that belongs to one panel
instance. The host stores it with the saved layout and passes it back to
`PanelDefinition.createWidget(instanceId, host, state)` after a restart, so a
restored tab remembers what it was opened for. Use it instead of plugin-level
"current selection" state whenever a panel type can be open more than once.
