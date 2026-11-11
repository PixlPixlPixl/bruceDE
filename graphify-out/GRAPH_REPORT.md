# Graph Report - icebox  (2026-11-11)

## Corpus Check
- 102 files · ~64,028 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: .cmd 6, (none) 1, .css 1)

## Summary
- 1587 nodes · 2668 edges · 121 communities (71 shown, 50 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 91 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `620e833b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Plugin Build Scripts
- Git Plugin
- Host Panel Capabilities
- Plugin Runtime Manifests
- File Browser Plugin
- Agent Chat Frontend
- Plugin Manager UI
- Runtime Verification Script
- Plugin Kernel And Host Modules
- Agent Chat Backend
- Plugin Kernel Wiring
- Service And Event Registries
- Plugin API Contracts
- Workspace Panel Registry
- dependencies
- Root Package Metadata
- PluginHostBackendService
- acp.ts
- plugin-manager-styles.ts
- Agent Chat Shared Types
- Git Package Metadata
- ACP Connection
- Workspace Shell And Panels
- Plugin Host Protocol
- Frontend Module Wiring
- Agent Turn Lifecycle
- workspace-core-frontend-module.ts
- icebox.mjs
- Agent Chat Package Metadata
- Pi RPC Connection
- File Browser Package Metadata
- Terminal Package Metadata
- Workspace Core TypeScript Config
- Workspace Resource Service
- File Browser Manifest
- projects/src/frontend/index.tsx
- Workspace Core Package Metadata
- Plugin API TS Config
- Plugin Runtime TS Config
- projects/plugin.json
- Terminal Manifest
- Canvas Shell Layout
- projects/src/backend/index.ts
- Plugin Runtime Package Metadata
- UI Kit Package Metadata
- Agent Chat Panel UI
- dependencies
- Theia Terminal Dependencies
- Agent Sessions Service
- Git Manifest
- Discovery And Manifest Rules
- Trust And Plugin Runtime
- HostModuleRegistry
- Browser App Dependencies
- Root Dev Dependencies
- Agent Chat Manifest
- Plugin Host Client RPC
- Host Module Sharing
- Browser Theia Preferences
- Electron Theia Preferences
- Panel Registry API
- projects/package.json
- Plugin Folder Rules
- Panel Ownership Disposal
- WorkspaceLayoutService
- electron-app/package.json
- Service Registry API
- Plugin Runtime Peer Deps
- build-all.mjs
- Plugin API Surfaces
- Resource Service API
- Selection Service API
- Plugin Runtime Exports
- Agent Chat Contributions
- ProjectsPanel
- Host React Widget
- projects/src/shared.ts
- Plugin Event API
- browser-app/package.json
- Agent Chat Entrypoints
- Agent Picker Rendering
- Backend Plugin Module
- Command Registry API
- Frontend Plugin Module
- Panel Host Tools API
- UI Kit Tokens
- startAcp
- ProjectsService
- config
- config
- host-modules.ts
- scripts
- AgentSessionsView
- @icebox/plugin-api@0.1.0
- @icebox/plugin-runtime@0.1.0
- @theia/core@1.77.0
- @theia/editor@1.77.0
- @theia/markers@1.77.0
- @theia/navigator@1.77.0
- @theia/process@1.77.0
- @theia/workspace@1.77.0
- workspace-core@0.1.0
- @icebox/plugin-runtime@0.1.0
- @icebox/ui-kit@0.1.0
- @theia/core@1.77.0
- @theia/editor@1.77.0
- @theia/filesystem@1.77.0
- @theia/markers@1.77.0
- @theia/messages@1.77.0
- @theia/preferences@1.77.0
- @theia/terminal@1.77.0
- workspace-core@0.1.0
- install.sh
- AgentChatLauncherService
- WorkspaceDialogsService
- start-browser.sh
- start-electron.sh
- status.sh
- uninstall.sh
- update.sh

## God Nodes (most connected - your core abstractions)
1. `WorkspacePanelRegistry` - 30 edges
2. `PluginHostBackendService` - 28 edges
3. `PluginManager` - 25 edges
4. `PluginServiceRegistry` - 21 edges
5. `activate()` - 18 edges
6. `PiRpcConnection` - 18 edges
7. `AgentChat()` - 17 edges
8. `WorkspaceDockingService` - 17 edges
9. `PluginHostSnapshot` - 17 edges
10. `status()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `One Host Code Path per Panel Kind` --conceptually_related_to--> `CanvasTerminalShellHandler`  [EXTRACTED]
  AGENTS.md → workspace-core/src/browser/canvas-terminal.ts
- `Automatic Panel Closure on Unload` --references--> `WorkspacePanelWidgetFactory`  [EXTRACTED]
  README.md → workspace-core/src/browser/workspace-panel-factory.ts
- `Trust and Enabled State Store` --references--> `PluginStateStore`  [EXTRACTED]
  plugins/AGENTS.md → workspace-core/src/node/plugin-state-store.ts
- `Independent Layout Persistence` --conceptually_related_to--> `Canvas Shell Layout`  [INFERRED]
  AGENTS.md → workspace-core/README.md
- `Browser Target Port and Hostname Flags` --references--> `start`  [EXTRACTED]
  README.md → browser-app/package.json

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Host Capability Ownership Flow** — agents_host_panel_capabilities, workspace_core_readme_host_capability_catalog, workspace_core_readme_host_owned_panels, plugins_agents_host_factory_ownership, packages_plugin_api_readme_host_capability_contract [EXTRACTED 1.00]
- **Shared Package Build Bootstrap** — readme_postinstall_build_order, readme_workspace_core_build, plugins_agents_postinstall_types, readme_node_bin_wrappers, agents_node_entrypoint_scripts [EXTRACTED 1.00]
- **Trust Disclosure Flow** — agents_full_system_access, agents_trust_warning_disclosure, readme_trust_warning, plugins_readme_third_party_trust, workspace_core_readme_trust_badge [EXTRACTED 1.00]

## Communities (121 total, 50 thin omitted)

### Community 0 - "Plugin Build Scripts"
Cohesion: 0.21
Nodes (10): ensure-ffmpeg-addon Build Step, native:ffmpeg, @theia/ffmpeg Native Addon, ADDON_PATHS, main(), repoRoot, requireFromRoot, resolveFfmpegPackage() (+2 more)

### Community 1 - "Git Plugin"
Cohesion: 0.07
Nodes (40): activate(), describeError(), LineCounts, ParsedStatus, parseNumstat(), parsePorcelainV2(), readLineCounts(), readStatus() (+32 more)

### Community 2 - "Host Panel Capabilities"
Cohesion: 0.16
Nodes (7): Curated Host Panel Capabilities, Host Panel Capability Contract, HOST_PANEL_CAPABILITIES, Adopting a Host Capability, Host Panel Capability Catalog, icebox.terminal Host Factory, HostPanelFactoryRegistry

### Community 3 - "Plugin Runtime Manifests"
Cohesion: 0.09
Nodes (23): DisposerBag, toDisposer(), ActivateExport, CordisPluginManager, CordisPluginManagerOptions, PluginLoadRequest, PluginModule, PluginRuntimeRecord (+15 more)

### Community 4 - "File Browser Plugin"
Cohesion: 0.08
Nodes (25): activate(), compareEntries(), DISABLED_STYLE, displayPath(), Entry, FileBrowser(), FileBrowserProps, filePath() (+17 more)

### Community 5 - "Agent Chat Frontend"
Cohesion: 0.06
Nodes (34): AGENT_NAME_STYLE, BUTTON_STYLE, COMPLETION_STYLE, CompletionItem, CompletionKind, CompletionView, COMPOSER_STYLE, ENTRY_STYLE (+26 more)

### Community 6 - "Plugin Manager UI"
Cohesion: 0.22
Nodes (3): PluginManager, toManifest(), PluginDescriptor

### Community 7 - "Runtime Verification Script"
Cohesion: 0.07
Nodes (26): api, blobMap, bus, check(), collectPluginSources(), compiled, duplicateFirst, duplicateSecond (+18 more)

### Community 9 - "Agent Chat Backend"
Cohesion: 0.11
Nodes (16): acpUsage(), AgentCandidate, AgentLink, discoverAgents(), isProtocol(), KNOWN_AGENTS, PiBashResult, PiModel (+8 more)

### Community 10 - "Plugin Kernel Wiring"
Cohesion: 0.10
Nodes (9): PluginFrontendHostOptions, DOCK_MODES, PluginKernelOptions, WorkspaceDockingService, BackendRecord, describeError(), importBackendModule(), PluginBackendLogger (+1 more)

### Community 11 - "Service And Event Registries"
Cohesion: 0.10
Nodes (5): WorkspaceDialogService, WorkspaceSelectionService, PluginEventBus, PluginServiceRegistry, createBackendApi()

### Community 12 - "Plugin API Contracts"
Cohesion: 0.06
Nodes (33): AgentChatOpenOptions, AgentDescriptor, AgentProtocol, AgentSessionChange, AgentSessionHandle, AgentSessionOptions, AgentSessionSummary, AgentStatus (+25 more)

### Community 13 - "Workspace Panel Registry"
Cohesion: 0.08
Nodes (3): Host Factory Lifetime, Host-Owned Capability Panels, WorkspacePanelRegistry

### Community 14 - "dependencies"
Cohesion: 0.18
Nodes (11): dependencies, @icebox/ui-kit@0.1.0, @theia/filesystem@1.77.0, @theia/messages@1.77.0, @theia/monaco@1.77.0, @theia/preferences@1.77.0, @icebox/ui-kit, @theia/filesystem (+3 more)

### Community 15 - "Root Package Metadata"
Cohesion: 0.09
Nodes (24): devDependencies, lerna@^8.2.4, @types/react-dom@^19.3.0, engines, node, npm, name, private (+16 more)

### Community 16 - "PluginHostBackendService"
Cohesion: 0.05
Nodes (24): Trust and Enabled State Store, PluginDiagnostic, PluginHostSnapshot, PluginBackendRuntime, describeError(), DiscoveredPlugin, discoverPlugins(), DiscoveryResult (+16 more)

### Community 17 - "acp.ts"
Cohesion: 0.11
Nodes (18): ACP_PROTOCOL_VERSION, AcpHandlers, AcpInitializeResult, AcpLoadSessionResult, AcpModelInfo, AcpNewSessionResult, AcpPromptResult, AcpPromptUsage (+10 more)

### Community 18 - "plugin-manager-styles.ts"
Cohesion: 0.05
Nodes (43): dependencies, @lumino/widgets@2.7.5, react@^19.3.1, description, devDependencies, @types/react@^19.3.0, typescript@5.9.3, exports (+35 more)

### Community 19 - "Agent Chat Shared Types"
Cohesion: 0.13
Nodes (9): AgentIntrospection, LiveSession, ModelMenuProps, AgentCommand, AgentModelInfo, AgentModelState, AgentState, AgentUsageInfo (+1 more)

### Community 20 - "Git Package Metadata"
Cohesion: 0.15
Nodes (15): description, devDependencies, @icebox/plugin-build@0.1.0, @icebox/plugin-api, @icebox/plugin-build, @icebox/ui-kit, name, peerDependencies (+7 more)

### Community 22 - "Workspace Shell And Panels"
Cohesion: 0.21
Nodes (10): WorkspacePanelOpenOptions, WorkspacePanelWidgetFactory, isPlainJson(), isWorkspacePanelWidgetOptions(), RegisteredWorkspacePanel, WORKSPACE_PANEL_FACTORY_ID, WorkspacePanelDefinition, WorkspacePanelState (+2 more)

### Community 23 - "Plugin Host Protocol"
Cohesion: 0.17
Nodes (6): PLUGIN_HOST_PATH, PLUGIN_SERVICE_RPC_PATH, PluginContributionSummary, PluginServiceBridge, PluginServiceBridgeImpl, pluginHostConnectionModule

### Community 24 - "Frontend Module Wiring"
Cohesion: 0.28
Nodes (3): Terminal Placement Override, CanvasTerminalFrontendContribution, CanvasTerminalShellHandler

### Community 25 - "Agent Turn Lifecycle"
Cohesion: 0.17
Nodes (23): activate(), drainQueue(), ensureStarted(), failSession(), guard(), handleExit(), inlineMentions(), midTurnMessage() (+15 more)

### Community 26 - "workspace-core-frontend-module.ts"
Cohesion: 0.12
Nodes (11): OPEN_PLUGIN_MANAGER, brand(), WorkspaceIconThemeService, WorkspaceThemeService, WorkspaceHostStyles, LOAD_LAYOUT, SAVE_LAYOUT, StoredLayout (+3 more)

### Community 27 - "icebox.mjs"
Cohesion: 0.11
Nodes (57): appBuilt(), bold(), childEnvironment(), confirm(), depsFingerprint(), detail(), dim(), ensureDependencies() (+49 more)

### Community 28 - "Agent Chat Package Metadata"
Cohesion: 0.15
Nodes (15): description, devDependencies, @icebox/plugin-build@0.1.0, @icebox/plugin-api, @icebox/plugin-build, @icebox/ui-kit, name, peerDependencies (+7 more)

### Community 30 - "File Browser Package Metadata"
Cohesion: 0.15
Nodes (15): description, devDependencies, @icebox/plugin-build@0.1.0, @icebox/plugin-api, @icebox/plugin-build, @icebox/ui-kit, name, peerDependencies (+7 more)

### Community 31 - "Terminal Package Metadata"
Cohesion: 0.15
Nodes (15): description, devDependencies, @icebox/plugin-build@0.1.0, @icebox/plugin-api, @icebox/plugin-build, @icebox/ui-kit, name, peerDependencies (+7 more)

### Community 32 - "Workspace Core TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, emitDecoratorMetadata, experimentalDecorators, lib, module, moduleResolution, noEmitOnError (+7 more)

### Community 33 - "Workspace Resource Service"
Cohesion: 0.25
Nodes (3): Host-Published Workspace Services, toResourceStat(), WorkspaceResourceService

### Community 34 - "File Browser Manifest"
Cohesion: 0.13
Nodes (15): apiVersion, contributes, commands, panels, services, dependencies, icebox.workspace@^0.1.0, description (+7 more)

### Community 35 - "projects/src/frontend/index.tsx"
Cohesion: 0.06
Nodes (35): AgentPicker(), ARCHIVE_SECTION_STYLE, ARCHIVE_TOGGLE_STYLE, ARCHIVED_ROW_STYLE, BODY_STYLE, CHEVRON_STYLE, compareAgents(), CONFIRM_STYLE (+27 more)

### Community 36 - "Workspace Core Package Metadata"
Cohesion: 0.08
Nodes (32): dependencies, @icebox/plugin-api@0.1.0, @icebox/plugin-runtime@0.1.0, @icebox/ui-kit@0.1.0, @lumino/widgets@2.7.5, @theia/core@1.77.0, @theia/filesystem@1.77.0, @theia/terminal@1.77.0 (+24 more)

### Community 37 - "Plugin API TS Config"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, lib, module, moduleResolution, noEmitOnError, outDir, rootDir (+5 more)

### Community 38 - "Plugin Runtime TS Config"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, lib, module, moduleResolution, noEmitOnError, outDir, rootDir (+5 more)

### Community 39 - "projects/plugin.json"
Cohesion: 0.12
Nodes (17): apiVersion, contributes, commands, panels, services, dependencies, icebox.agent-chat@^0.1.0, icebox.workspace@^0.1.0 (+9 more)

### Community 40 - "Terminal Manifest"
Cohesion: 0.14
Nodes (14): apiVersion, contributes, commands, panels, dependencies, icebox.workspace@^0.1.0, description, entrypoints (+6 more)

### Community 41 - "Canvas Shell Layout"
Cohesion: 0.20
Nodes (7): No Prescribed Dock Placement, Plugin-First Desktop Workspace, Repository Layout, Theia 1.77.0 Version Pin, Canvas Shell Layout, Main DockPanel Shell, CanvasApplicationShell

### Community 42 - "projects/src/backend/index.ts"
Cohesion: 0.21
Nodes (9): activate(), defaultTitle(), parseProjects(), parseSession(), projectsFile(), readHandle(), readString(), sameHandle() (+1 more)

### Community 43 - "Plugin Runtime Package Metadata"
Cohesion: 0.08
Nodes (25): dependencies, @deepseek-ai/cordis@4.1.0, @deepseek-ai/cordis-plugin-loader@1.1.0, @icebox/plugin-api@0.1.0, description, devDependencies, typescript@5.9.3, exports (+17 more)

### Community 44 - "UI Kit Package Metadata"
Cohesion: 0.17
Nodes (12): description, exports, ./package.json, ./theme.css, files, @icebox/plugin-api, name, peerDependencies (+4 more)

### Community 45 - "Agent Chat Panel UI"
Cohesion: 0.18
Nodes (14): activate(), AgentChat(), availableAgents(), commandItem(), fileItems(), formatTokens(), isSessionHandle(), renderCacheChip() (+6 more)

### Community 46 - "dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @icebox/plugin-api@0.1.0, @theia/electron@1.77.0, @theia/monaco@1.77.0, @theia/navigator@1.77.0, @theia/process@1.77.0, @theia/workspace@1.77.0, @icebox/plugin-api (+5 more)

### Community 47 - "Theia Terminal Dependencies"
Cohesion: 0.12
Nodes (8): HOST_PANEL_CAPABILITY_PATTERN, HostPanelCreateRequest, HostPanelFactory, TerminalHostPanelFactory, sameRanges(), sameSelection(), EventListener, OwnedService

### Community 49 - "Git Manifest"
Cohesion: 0.13
Nodes (15): apiVersion, contributes, commands, panels, services, dependencies, icebox.workspace@^0.1.0, description (+7 more)

### Community 50 - "Discovery And Manifest Rules"
Cohesion: 0.22
Nodes (9): Plugin Loading Flow, Plugin Discovery Order, Strict Manifest Validation, Plugin Manifest Fields, Plugin Folder Structure, Automatic Plugin Discovery, Automatic Panel Closure on Unload, Writing a Plugin Entry Point (+1 more)

### Community 51 - "Trust And Plugin Runtime"
Cohesion: 0.20
Nodes (5): esbuild Plugin Bundler, Third-Party Plugin Trust Gate, Plugin Build Tooling, Third-Party Trust Confirmation, Plugin Manager Panel Styling

### Community 53 - "Browser App Dependencies"
Cohesion: 0.13
Nodes (12): Theia RPC Boundary, Services and Typed Events, Reserved Service and Event Ids, URI-Based Resource Contracts, Versioned Plugin Contracts, Cordis Plugin Manager, Manifest Validation, Compiled @icebox Types Before TypeScript Runs (+4 more)

### Community 54 - "Root Dev Dependencies"
Cohesion: 0.35
Nodes (10): buildBackend(), buildFrontend(), buildPlugin(), exists(), hasAny(), HOST_MODULES, main(), pickEntry() (+2 more)

### Community 55 - "Agent Chat Manifest"
Cohesion: 0.13
Nodes (15): apiVersion, contributes, commands, panels, services, dependencies, icebox.workspace@^0.1.0, description (+7 more)

### Community 56 - "Plugin Host Client RPC"
Cohesion: 0.22
Nodes (3): Plugin Bundle Delivery Paths, PLUGIN_ASSET_PREFIX, PluginHostClient

### Community 57 - "Host Module Sharing"
Cohesion: 0.21
Nodes (12): Host Module Blob Shim, Bundled Feature Plugins, Adopting the Host Terminal Capability, Host Module Allowlist, Panel Host Tools, Panel Disposal on Unload, Plugin Runtime Contract, Frontend ESM Bundle Loading (+4 more)

### Community 58 - "Browser Theia Preferences"
Cohesion: 0.20
Nodes (10): bin, icebox-plugin-build, dependencies, esbuild@^0.28.2, description, name, private, type (+2 more)

### Community 61 - "projects/package.json"
Cohesion: 0.15
Nodes (15): description, devDependencies, @icebox/plugin-build@0.1.0, @icebox/plugin-api, @icebox/plugin-build, @icebox/ui-kit, name, peerDependencies (+7 more)

### Community 62 - "Plugin Folder Rules"
Cohesion: 0.33
Nodes (3): Backend Entry Must Be src/backend/index.ts, Plugin Folder Layout, Scaffold Feature Plugins

### Community 63 - "Panel Ownership Disposal"
Cohesion: 0.20
Nodes (7): Cordis-Managed Plugin Fiber, ESM Module Cache and Code-Unload Limits, Panel Ownership and Disposal, Exactly One Restoration Owner per Widget, Disposer Bag, activate(api) Runtime Contract, Single Restoration Authority

### Community 65 - "electron-app/package.json"
Cohesion: 0.20
Nodes (11): description, devDependencies, electron@44.9.1, @theia/cli@1.77.0, @theia/cli, main, name, private (+3 more)

### Community 67 - "Plugin Runtime Peer Deps"
Cohesion: 0.32
Nodes (7): Independent Layout Persistence, Per-Instance Panel State Contract, Per-Instance Panel State, One Agent Session per Chat Tab, Agent Wire Protocols (ACP and pi-rpc), Layout and Instance-State Persistence, Unavailable Panel Placeholder

### Community 68 - "build-all.mjs"
Cohesion: 0.15
Nodes (9): here, main(), message(), pluginsRoot, repositoryRoot, appDir, changed, INDEX_FILES (+1 more)

### Community 69 - "Plugin API Surfaces"
Cohesion: 0.50
Nodes (3): BackendPluginAPI, FrontendPluginAPI, PluginAPIBase

### Community 73 - "Agent Chat Contributions"
Cohesion: 0.40
Nodes (5): scripts, bundle, rebuild, start, watch

### Community 74 - "ProjectsPanel"
Cohesion: 0.23
Nodes (12): activate(), ArchivedProjectRow(), ArchivedSessionRow(), ConfirmDelete(), describeStatus(), formatWhen(), messageOf(), newSessionId() (+4 more)

### Community 76 - "projects/src/shared.ts"
Cohesion: 0.22
Nodes (8): PersistedShape, Actions, ProjectRowProps, SessionRowProps, NewProjectSession, ProjectRecord, ProjectSessionRecord, ProjectsSnapshot

### Community 78 - "browser-app/package.json"
Cohesion: 0.22
Nodes (9): @theia/terminal@1.77.0, description, devDependencies, @theia/cli@1.77.0, @theia/cli, @theia/terminal, name, private (+1 more)

### Community 80 - "Agent Picker Rendering"
Cohesion: 1.00
Nodes (3): describeAgent(), protocolLabel(), renderPicker()

### Community 87 - "startAcp"
Cohesion: 0.31
Nodes (10): startAcp(), isLoadSessionSupported(), parseAcpCommands(), piContentBlocks(), piContentText(), piTranscript(), readString(), requestFromAgent() (+2 more)

### Community 89 - "config"
Cohesion: 0.25
Nodes (8): applicationName, defaultTheme, preferences, config, workbench.colorTheme, theia, frontend, target

### Community 90 - "config"
Cohesion: 0.25
Nodes (8): applicationName, defaultTheme, preferences, config, workbench.colorTheme, theia, frontend, target

### Community 91 - "host-modules.ts"
Cohesion: 0.38
Nodes (5): HOST_MODULE_NAMESPACES, HostModuleNamespace, escapeRegExp(), rewriteHostModuleSpecifiers(), HOST_MODULE_PREFIX

### Community 92 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, bundle, rebuild, start, watch, Browser Target Port and Hostname Flags

## Knowledge Gaps
- **13 isolated node(s):** `Browser Target Port and Hostname Flags`, `Trust and Enabled State Store`, `Plugin-First Desktop Workspace`, `Repository Layout`, `Theia 1.77.0 Version Pin` (+8 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 662 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **50 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `native:ffmpeg` connect `Plugin Build Scripts` to `Agent Chat Contributions`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **What connects `Browser Target Port and Hostname Flags`, `Trust and Enabled State Store`, `Plugin-First Desktop Workspace` to the rest of the system?**
  _13 weakly-connected nodes found - possible missing edges._
- **Should `Git Plugin` be split into smaller, more focused modules?**
  _Cohesion score 0.06570048309178744 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Agent Chat Contributions` to `Plugin Build Scripts`, `electron-app/package.json`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **Should `Plugin Runtime Manifests` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._
- **Should `File Browser Plugin` be split into smaller, more focused modules?**
  _Cohesion score 0.08067226890756303 - nodes in this community are weakly interconnected._
- **Should `Agent Chat Frontend` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._