# Graph Report - Icebox  (2026-11-10)

## Corpus Check
- 58 files · ~48,074 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1276 nodes · 2118 edges · 87 communities (68 shown, 19 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 83 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

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
- Theia App Dependencies
- Root Package Metadata
- Plugin Host Backend Service
- Agent Process Spawning
- Plugin Manager Styling
- Agent Chat Shared Types
- Git Package Metadata
- ACP Connection
- Workspace Shell And Panels
- Plugin Host Protocol
- Frontend Module Wiring
- Agent Turn Lifecycle
- Host Terminal Capability
- Plugin API Package Metadata
- Agent Chat Package Metadata
- Pi RPC Connection
- File Browser Package Metadata
- Terminal Package Metadata
- Workspace Core TypeScript Config
- Workspace Resource Service
- File Browser Manifest
- Backend Host And State Store
- Workspace Core Package Metadata
- Plugin API TS Config
- Plugin Runtime TS Config
- Plugin State Store
- Terminal Manifest
- Canvas Shell Layout
- Plugin Discovery
- Plugin Runtime Package Metadata
- UI Kit Package Metadata
- Agent Chat Panel UI
- Electron App Metadata
- Theia Terminal Dependencies
- Agent Sessions Service
- Git Manifest
- Discovery And Manifest Rules
- Trust And Plugin Runtime
- Host-Owned Panel Disposal
- Browser App Dependencies
- Root Dev Dependencies
- Agent Chat Manifest
- Plugin Host Client RPC
- Host Module Sharing
- Browser Theia Preferences
- Electron Theia Preferences
- Panel Registry API
- Backend Plugin Runtime
- Plugin Folder Rules
- Panel Ownership Disposal
- Browser App Scripts
- Cordis Loader Dependencies
- Service Registry API
- Plugin Runtime Peer Deps
- Theia Filesystem Deps
- Plugin API Surfaces
- Resource Service API
- Selection Service API
- Plugin Runtime Exports
- Agent Chat Contributions
- Git Contributions
- Host React Widget
- Plugin API Package Scripts
- Plugin Event API
- Plugin Bundling
- Agent Chat Entrypoints
- Agent Picker Rendering
- Backend Plugin Module
- Command Registry API
- Frontend Plugin Module
- Panel Host Tools API
- UI Kit Tokens

## God Nodes (most connected - your core abstractions)
1. `WorkspacePanelRegistry` - 30 edges
2. `PluginHostBackendService` - 28 edges
3. `PluginManager` - 25 edges
4. `PluginServiceRegistry` - 19 edges
5. `activate()` - 18 edges
6. `PiRpcConnection` - 18 edges
7. `WorkspaceDockingService` - 17 edges
8. `PluginHostSnapshot` - 17 edges
9. `AgentChat()` - 16 edges
10. `AcpConnection` - 15 edges

## Surprising Connections (you probably didn't know these)
- `One Host Code Path per Panel Kind` --conceptually_related_to--> `CanvasTerminalShellHandler`  [EXTRACTED]
  AGENTS.md → workspace-core/src/browser/canvas-terminal.ts
- `Automatic Panel Closure on Unload` --references--> `WorkspacePanelWidgetFactory`  [EXTRACTED]
  README.md → workspace-core/src/browser/workspace-panel-factory.ts
- `Trust and Enabled State Store` --references--> `PluginStateStore`  [EXTRACTED]
  plugins/AGENTS.md → workspace-core/src/node/plugin-state-store.ts
- `@icebox/plugin-api@0.1.0` --declares--> `@icebox/plugin-api`  [EXTRACTED]
  packages/plugin-runtime/package.json → plugins/git/package.json
- `@icebox/plugin-api@0.1.0` --declares--> `@icebox/plugin-api`  [EXTRACTED]
  workspace-core/package.json → plugins/git/package.json

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Host Capability Ownership Flow** — agents_host_panel_capabilities, workspace_core_readme_host_capability_catalog, workspace_core_readme_host_owned_panels, plugins_agents_host_factory_ownership, packages_plugin_api_readme_host_capability_contract [EXTRACTED 1.00]
- **Trust Disclosure Flow** — agents_full_system_access, agents_trust_warning_disclosure, readme_trust_warning, plugins_readme_third_party_trust, workspace_core_readme_trust_badge [EXTRACTED 1.00]
- **Shared Package Build Bootstrap** — readme_postinstall_build_order, readme_workspace_core_build, plugins_agents_postinstall_types, readme_node_bin_wrappers, agents_node_entrypoint_scripts [EXTRACTED 1.00]

## Communities (87 total, 19 thin omitted)

### Community 0 - "Plugin Build Scripts"
Cohesion: 0.06
Nodes (40): ensure-ffmpeg-addon Build Step, scripts, bundle, native:ffmpeg, rebuild, start, watch, here (+32 more)

### Community 1 - "Git Plugin"
Cohesion: 0.06
Nodes (40): activate(), describeError(), LineCounts, ParsedStatus, parseNumstat(), parsePorcelainV2(), readLineCounts(), readStatus() (+32 more)

### Community 2 - "Host Panel Capabilities"
Cohesion: 0.06
Nodes (30): Cordis-Managed Plugin Fiber, ESM Module Cache and Code-Unload Limits, Curated Host Panel Capabilities, Theia RPC Boundary, Services and Typed Events, Host Panel Capability Contract, Per-Instance Panel State Contract, Reserved Service and Event Ids (+22 more)

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
Cohesion: 0.10
Nodes (4): PluginManagerCommands, PluginManager, PluginManagerWidget, PluginDescriptor

### Community 7 - "Runtime Verification Script"
Cohesion: 0.07
Nodes (28): api, blobMap, bus, check(), collectHostSources(), walk(), collectPluginSources(), compiled (+20 more)

### Community 8 - "Plugin Kernel And Host Modules"
Cohesion: 0.10
Nodes (9): HOST_MODULE_NAMESPACES, HostModuleNamespace, HostModuleRegistry, namespaceStore(), PluginFrontendHost, PluginKernel, escapeRegExp(), rewriteHostModuleSpecifiers() (+1 more)

### Community 9 - "Agent Chat Backend"
Cohesion: 0.11
Nodes (27): acpUsage(), startAcp(), AgentCandidate, AgentLink, appendAcpUpdate(), appendAgentText(), appendPiEvent(), contentText() (+19 more)

### Community 10 - "Plugin Kernel Wiring"
Cohesion: 0.10
Nodes (9): PluginFrontendHostOptions, DOCK_MODES, PluginKernelOptions, WorkspaceDockingService, BackendRecord, describeError(), importBackendModule(), PluginBackendLogger (+1 more)

### Community 11 - "Service And Event Registries"
Cohesion: 0.11
Nodes (8): sameRanges(), sameSelection(), WorkspaceSelectionService, EventListener, OwnedService, PluginEventBus, PluginServiceRegistry, createBackendApi()

### Community 12 - "Plugin API Contracts"
Cohesion: 0.08
Nodes (25): ICEBOX_PLUGIN_API_VERSION, ICEBOX_WORKSPACE_PLUGIN_ID, CommandDefinition, DockMode, HostPanelCapabilityId, HostPanelRegistration, PanelDefinition, PanelOpenOptions (+17 more)

### Community 14 - "Theia App Dependencies"
Cohesion: 0.10
Nodes (25): dependencies, @theia/editor@1.77.0, @theia/markers@1.77.0, @theia/messages@1.77.0, @theia/monaco@1.77.0, @theia/navigator@1.77.0, @theia/process@1.77.0, @theia/workspace@1.77.0 (+17 more)

### Community 15 - "Root Package Metadata"
Cohesion: 0.09
Nodes (23): devDependencies, lerna@^8.2.4, @types/react-dom@^19.3.0, engines, node, npm, private, scripts (+15 more)

### Community 16 - "Plugin Host Backend Service"
Cohesion: 0.18
Nodes (4): PluginHostSnapshot, DiscoveredPlugin, isUserPluginPath(), PluginHostBackendService

### Community 17 - "Agent Process Spawning"
Cohesion: 0.11
Nodes (17): ACP_PROTOCOL_VERSION, AcpHandlers, AcpInitializeResult, AcpModelInfo, AcpNewSessionResult, AcpPromptResult, AcpPromptUsage, JsonRpcMessage (+9 more)

### Community 18 - "Plugin Manager Styling"
Cohesion: 0.09
Nodes (21): ACTIONS_STYLE, BADGE_STYLE, BUTTON_STYLE, DESCRIPTION_STYLE, DIAGNOSTICS_LIST_STYLE, DIAGNOSTICS_STYLE, DIAGNOSTICS_SUMMARY_STYLE, DISABLED_BUTTON_STYLE (+13 more)

### Community 19 - "Agent Chat Shared Types"
Cohesion: 0.14
Nodes (12): AgentIntrospection, LiveSession, ModelMenuProps, AgentCommand, AgentDescriptor, AgentModelInfo, AgentModelState, AgentProtocol (+4 more)

### Community 20 - "Git Package Metadata"
Cohesion: 0.12
Nodes (19): @icebox/plugin-api@0.1.0, @icebox/ui-kit@0.1.0, @icebox/plugin-api@0.1.0, @icebox/ui-kit@0.1.0, description, devDependencies, @icebox/plugin-build@0.1.0, @icebox/plugin-api (+11 more)

### Community 22 - "Workspace Shell And Panels"
Cohesion: 0.21
Nodes (10): WorkspacePanelOpenOptions, WorkspacePanelWidgetFactory, isPlainJson(), isWorkspacePanelWidgetOptions(), RegisteredWorkspacePanel, WORKSPACE_PANEL_FACTORY_ID, WorkspacePanelDefinition, WorkspacePanelState (+2 more)

### Community 23 - "Plugin Host Protocol"
Cohesion: 0.14
Nodes (6): PLUGIN_HOST_PATH, PLUGIN_SERVICE_RPC_PATH, PluginContributionSummary, PluginServiceBridge, PluginServiceBridgeImpl, pluginHostConnectionModule

### Community 24 - "Frontend Module Wiring"
Cohesion: 0.21
Nodes (5): Terminal Placement Override, CanvasTerminalFrontendContribution, CanvasTerminalShellHandler, OPEN_PLUGIN_MANAGER, toManifest()

### Community 25 - "Agent Turn Lifecycle"
Cohesion: 0.25
Nodes (17): activate(), drainQueue(), ensureStarted(), failSession(), guard(), handleExit(), inlineMentions(), midTurnMessage() (+9 more)

### Community 26 - "Host Terminal Capability"
Cohesion: 0.18
Nodes (4): HOST_PANEL_CAPABILITY_PATTERN, HostPanelCreateRequest, HostPanelFactory, TerminalHostPanelFactory

### Community 27 - "Plugin API Package Metadata"
Cohesion: 0.14
Nodes (15): dependencies, @lumino/widgets@2.7.5, react@^19.3.1, description, exports, files, main, name (+7 more)

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

### Community 34 - "File Browser Manifest"
Cohesion: 0.13
Nodes (14): apiVersion, contributes, commands, panels, services, dependencies, icebox.workspace@^0.1.0, description (+6 more)

### Community 35 - "Backend Host And State Store"
Cohesion: 0.20
Nodes (7): CONTENT_TYPES, safeDecode(), resolvePluginRoots(), resolveStateFile(), USER_DATA_DIR_NAME, PersistedShape, PluginStateEntry

### Community 36 - "Workspace Core Package Metadata"
Cohesion: 0.13
Nodes (14): description, exports, ./lib/*, ./package.json, files, keywords, name, private (+6 more)

### Community 37 - "Plugin API TS Config"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, lib, module, moduleResolution, noEmitOnError, outDir, rootDir (+5 more)

### Community 38 - "Plugin Runtime TS Config"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, lib, module, moduleResolution, noEmitOnError, outDir, rootDir (+5 more)

### Community 39 - "Plugin State Store"
Cohesion: 0.20
Nodes (3): Trust and Enabled State Store, isPersistedShape(), PluginStateStore

### Community 40 - "Terminal Manifest"
Cohesion: 0.14
Nodes (13): apiVersion, contributes, commands, panels, dependencies, icebox.workspace@^0.1.0, description, entrypoints (+5 more)

### Community 41 - "Canvas Shell Layout"
Cohesion: 0.17
Nodes (8): Independent Layout Persistence, No Prescribed Dock Placement, Plugin-First Desktop Workspace, Repository Layout, Theia 1.77.0 Version Pin, Canvas Shell Layout, Main DockPanel Shell, CanvasApplicationShell

### Community 42 - "Plugin Discovery"
Cohesion: 0.23
Nodes (9): PluginDiagnostic, describeError(), discoverPlugins(), DiscoveryResult, normalizeRelativePath(), resolveCrossDependencies(), resolveEntrypoints(), toDescriptor() (+1 more)

### Community 43 - "Plugin Runtime Package Metadata"
Cohesion: 0.15
Nodes (12): description, files, keywords, main, name, private, scripts, build (+4 more)

### Community 44 - "UI Kit Package Metadata"
Cohesion: 0.17
Nodes (12): description, exports, ./package.json, ./theme.css, files, @icebox/plugin-api, name, peerDependencies (+4 more)

### Community 45 - "Agent Chat Panel UI"
Cohesion: 0.19
Nodes (13): activate(), AgentChat(), availableAgents(), commandItem(), fileItems(), formatTokens(), renderCacheChip(), renderCompletion() (+5 more)

### Community 46 - "Electron App Metadata"
Cohesion: 0.18
Nodes (11): workspace-core@0.1.0, workspace-core, workspace-core@0.1.0, devDependencies, electron@44.9.1, @theia/cli@1.77.0, main, name (+3 more)

### Community 47 - "Theia Terminal Dependencies"
Cohesion: 0.18
Nodes (11): @theia/core@1.77.0, @theia/terminal@1.77.0, @theia/core, @theia/terminal, @theia/core@1.77.0, @theia/terminal@1.77.0, dependencies, @icebox/plugin-api@0.1.0 (+3 more)

### Community 49 - "Git Manifest"
Cohesion: 0.18
Nodes (10): apiVersion, dependencies, icebox.workspace@^0.1.0, description, entrypoints, backend, frontend, id (+2 more)

### Community 50 - "Discovery And Manifest Rules"
Cohesion: 0.20
Nodes (8): Cordis Plugin Manager, Manifest Validation, Plugin Discovery Order, Strict Manifest Validation, Plugin Manifest Fields, Plugin Folder Structure, Automatic Plugin Discovery, Writing a Plugin Entry Point

### Community 51 - "Trust And Plugin Runtime"
Cohesion: 0.22
Nodes (4): Third-Party Plugin Trust Gate, Implemented Plugin Runtime, Third-Party Trust Confirmation, Plugin Manager Panel Styling

### Community 52 - "Host-Owned Panel Disposal"
Cohesion: 0.22
Nodes (4): Exactly One Restoration Owner per Widget, Host Factory Lifetime, Host-Owned Capability Panels, Single Restoration Authority

### Community 53 - "Browser App Dependencies"
Cohesion: 0.22
Nodes (9): @theia/preferences@1.77.0, devDependencies, @theia/cli@1.77.0, @theia/cli, @theia/preferences, name, private, version (+1 more)

### Community 54 - "Root Dev Dependencies"
Cohesion: 0.22
Nodes (9): devDependencies, @types/react@^19.3.0, typescript@5.9.3, devDependencies, typescript@5.9.3, @types/react, devDependencies, typescript@5.9.3 (+1 more)

### Community 55 - "Agent Chat Manifest"
Cohesion: 0.25
Nodes (8): apiVersion, dependencies, icebox.workspace@^0.1.0, description, id, name, version, icebox.workspace

### Community 56 - "Plugin Host Client RPC"
Cohesion: 0.28
Nodes (3): Plugin Bundle Delivery Paths, PLUGIN_ASSET_PREFIX, PluginHostClient

### Community 57 - "Host Module Sharing"
Cohesion: 0.32
Nodes (8): Plugin Loading Flow, Host Module Blob Shim, Host Module Allowlist, Panel Host Tools, Frontend ESM Bundle Loading, Shared Host Module Resolution, Workspace Panel Registry, HOST_MODULES

### Community 58 - "Browser Theia Preferences"
Cohesion: 0.29
Nodes (7): defaultTheme, preferences, config, workbench.colorTheme, theia, frontend, target

### Community 59 - "Electron Theia Preferences"
Cohesion: 0.29
Nodes (7): defaultTheme, preferences, config, workbench.colorTheme, theia, frontend, target

### Community 62 - "Plugin Folder Rules"
Cohesion: 0.33
Nodes (3): Backend Entry Must Be src/backend/index.ts, Plugin Folder Layout, Scaffold Feature Plugins

### Community 63 - "Panel Ownership Disposal"
Cohesion: 0.47
Nodes (5): Panel Ownership and Disposal, Disposer Bag, Panel Disposal on Unload, Automatic Panel Closure on Unload, Workspace Docking Service

### Community 64 - "Browser App Scripts"
Cohesion: 0.33
Nodes (6): scripts, bundle, rebuild, start, watch, Browser Target Port and Hostname Flags

### Community 65 - "Cordis Loader Dependencies"
Cohesion: 0.33
Nodes (5): dependencies, @icebox/plugin-api@0.1.0, @deepseek-ai/cordis@4.1.0, @deepseek-ai/cordis-plugin-loader@1.1.0, @deepseek-ai/cordis-plugin-loader

### Community 67 - "Plugin Runtime Peer Deps"
Cohesion: 0.50
Nodes (4): @icebox/plugin-runtime@0.1.0, @icebox/plugin-runtime, @icebox/plugin-runtime@0.1.0, @icebox/plugin-runtime@0.1.0

### Community 68 - "Theia Filesystem Deps"
Cohesion: 0.50
Nodes (4): @theia/filesystem@1.77.0, @theia/filesystem, @theia/filesystem@1.77.0, @theia/filesystem@1.77.0

### Community 69 - "Plugin API Surfaces"
Cohesion: 0.50
Nodes (3): BackendPluginAPI, FrontendPluginAPI, PluginAPIBase

### Community 72 - "Plugin Runtime Exports"
Cohesion: 0.50
Nodes (4): exports, ./loader, import, types

### Community 73 - "Agent Chat Contributions"
Cohesion: 0.50
Nodes (4): contributes, commands, panels, services

### Community 74 - "Git Contributions"
Cohesion: 0.50
Nodes (4): contributes, commands, panels, services

### Community 76 - "Plugin API Package Scripts"
Cohesion: 0.67
Nodes (3): scripts, build, watch

### Community 79 - "Agent Chat Entrypoints"
Cohesion: 0.67
Nodes (3): entrypoints, backend, frontend

### Community 80 - "Agent Picker Rendering"
Cohesion: 1.00
Nodes (3): describeAgent(), protocolLabel(), renderPicker()

## Knowledge Gaps
- **13 isolated node(s):** `Optional UI Primitives`, `Shared Theme Tokens`, `Plugin-First Desktop Workspace`, `Manual build:workspace-core Fallback`, `Browser Target Port and Hostname Flags` (+8 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 534 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Plugin API Package Metadata` to `Git Plugin`, `File Browser Plugin`, `Agent Chat Frontend`, `Plugin Kernel Wiring`, `Plugin Manager Styling`, `Frontend Module Wiring`?**
  _High betweenness centrality (0.135) - this node is a cross-community bridge._
- **What connects `Optional UI Primitives`, `Shared Theme Tokens`, `Plugin-First Desktop Workspace` to the rest of the system?**
  _13 weakly-connected nodes found - possible missing edges._
- **Should `Plugin Build Scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.06105457909343201 - nodes in this community are weakly interconnected._
- **Why does `@deepseek-ai/cordis` connect `Plugin Runtime Manifests` to `Cordis Loader Dependencies`, `Plugin Runtime Package Metadata`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Should `Git Plugin` be split into smaller, more focused modules?**
  _Cohesion score 0.06475485661424607 - nodes in this community are weakly interconnected._
- **Why does `@icebox/plugin-api` connect `Git Package Metadata` to `Cordis Loader Dependencies`, `Workspace Core Package Metadata`, `Plugin Runtime Package Metadata`, `Electron App Metadata`, `Theia Terminal Dependencies`, `Browser App Dependencies`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Should `Host Panel Capabilities` be split into smaller, more focused modules?**
  _Cohesion score 0.057004830917874394 - nodes in this community are weakly interconnected._