# @brucede/plugin-api

Versioned contracts shared by the host and native plugins. Plugins use these types to contribute panels and communicate through shared services/events.

Keep this package independent of Cordis internals. Additive API changes are preferred; breaking changes require an `apiVersion` change and an explicit compatibility policy.

`apiVersion: 1` exposes:

- `FrontendPluginAPI` — `panels`, `commands`, `ui` (host React/Lumino), `services`, `events`, `origin`, `onDispose`.
- `BackendPluginAPI` — `services`, `events`, `workspace`, `origin`, `onDispose`.
- `ServiceRegistryAPI.remote<T>()` and `RemoteService<T>` — renderer → backend service calls over Theia's RPC channel.
- `WORKSPACE_SERVICE_IDS` / `WORKSPACE_EVENT_IDS` — the stable ids of host and first-party services and events.
- `ResourceUri`, `ResourceSelection`, `ResourceStat`, `WorkspaceResourcesService`, `WorkspaceSelectionService` — the URI-based cross-plugin data contracts.

Reserved but not yet provided by the host: `git.repository` (`WORKSPACE_SERVICE_IDS.gitRepository`), `agent.sessions` (`WORKSPACE_SERVICE_IDS.agentSessions`), and `git/changes-updated` (`WORKSPACE_EVENT_IDS.changesUpdated`). Feature plugins fill these in; the ids are frozen so a plugin can code against them now.
