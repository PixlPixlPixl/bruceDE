# Graph Report - bruceDE  (2026-11-09)

## Corpus Check
- Corpus is ~16,305 words - fits in a single context window. You may not need a graph.

## Summary
- 795 nodes · 1210 edges · 33 communities (28 shown, 5 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 54 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Plugin Host Discovery & Protocol
- Plugin API & Disposal Contracts
- Frontend Host & Bundle Loader
- Electron App Dependencies
- Browser App Dependencies
- Plugin Build Tooling
- Public Plugin API
- Architecture & Trust Model
- Workspace Core Package
- Plugin Runtime Package
- Root Workspace Scripts
- Plugin API Package Metadata
- Plugin API Runtime Types
- Agent Chat Plugin Package
- File Browser Plugin Package
- Git Plugin Package
- Terminal Plugin Package
- Workspace Core TS Config
- Plugin API TS Config
- Plugin Runtime TS Config
- Demo Workspace Panels
- Canvas Shell & Plugin Manager
- Host Module Rewriting
- Demo Contribution & Panel Registry
- UI Kit Package
- Agent Chat Manifest
- File Browser Manifest
- Git Manifest
- Terminal Manifest
- Panel Ownership Docking
- Service Registry
- Scaffold Plugins Policy
- Shared UI Tokens

## God Nodes (most connected - your core abstractions)
1. `PluginManager` - 23 edges
2. `PluginHostBackendService` - 22 edges
3. `WorkspaceDockingService` - 18 edges
4. `WorkspacePanelRegistry` - 17 edges
5. `PluginHostSnapshot` - 17 edges
6. `scripts` - 14 edges
7. `PluginFrontendHost` - 14 edges
8. `compilerOptions` - 14 edges
9. `compilerOptions` - 12 edges
10. `compilerOptions` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Disposer Bag` --conceptually_related_to--> `Panel Ownership and Disposal`  [INFERRED]
  packages/plugin-runtime/README.md → AGENTS.md
- `Versioned Plugin Contracts` --conceptually_related_to--> `Services and Typed Events`  [INFERRED]
  packages/plugin-api/README.md → AGENTS.md
- `Main DockPanel Shell` --conceptually_related_to--> `No Prescribed Dock Placement`  [INFERRED]
  workspace-core/README.md → AGENTS.md
- `Independent Layout Persistence` --conceptually_related_to--> `Canvas Application Shell`  [INFERRED]
  AGENTS.md → workspace-core/README.md
- `Automatic Plugin Discovery` --conceptually_related_to--> `Plugin Manifest Fields`  [INFERRED]
  README.md → plugins/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Host-Plugin Disposal Contract** — agents_panel_ownership_disposal, plugins_readme_panel_disposal, packages_plugin_runtime_readme_disposer_bag, readme_panel_ownership [EXTRACTED 1.00]
- **Trust Disclosure Thread** — agents_full_system_access, readme_trust_warning, plugins_readme_third_party_trust, packages_plugin_runtime_readme_no_sandbox [EXTRACTED 1.00]
- **Host Module Sharing Flow** — readme_host_modules, packages_plugin_build_readme_host_module_shim, plugins_readme_host_tools, readme_frontend_loader [EXTRACTED 1.00]

## Communities (33 total, 5 thin omitted)

### Community 0 - "Plugin Host Discovery & Protocol"
Cohesion: 0.05
Nodes (30): PLUGIN_ASSET_PREFIX, PluginDiagnostic, PluginHostSnapshot, BackendRecord, createBackendApi(), createEventBus(), createServiceRegistry(), describeError() (+22 more)

### Community 1 - "Plugin API & Disposal Contracts"
Cohesion: 0.05
Nodes (33): DisposerBag, toDisposer(), ActivateExport, CordisPluginManager, CordisPluginManagerOptions, PluginLoadRequest, PluginModule, PluginRuntimeRecord (+25 more)

### Community 2 - "Frontend Host & Bundle Loader"
Cohesion: 0.05
Nodes (10): HostModuleRegistry, namespaceStore(), PluginFrontendHost, PluginKernel, PluginManagerCommands, PluginManager, toManifest(), PluginManagerWidget (+2 more)

### Community 3 - "Electron App Dependencies"
Cohesion: 0.05
Nodes (49): dependencies, @brucede/plugin-api@0.1.0, @brucede/plugin-runtime@0.1.0, @brucede/ui-kit@0.1.0, @theia/core@1.77.0, @theia/editor@1.77.0, @theia/electron@1.77.0, @theia/filesystem@1.77.0 (+41 more)

### Community 4 - "Browser App Dependencies"
Cohesion: 0.06
Nodes (44): dependencies, @brucede/plugin-api@0.1.0, @brucede/plugin-runtime@0.1.0, @brucede/ui-kit@0.1.0, @theia/core@1.77.0, @theia/editor@1.77.0, @theia/filesystem@1.77.0, @theia/markers@1.77.0 (+36 more)

### Community 5 - "Plugin Build Tooling"
Cohesion: 0.06
Nodes (34): here, main(), message(), pluginsRoot, repositoryRoot, buildBackend(), buildFrontend(), buildPlugin() (+26 more)

### Community 6 - "Public Plugin API"
Cohesion: 0.06
Nodes (23): BackendPluginAPI, BackendPluginModule, BRUCE_PLUGIN_API_VERSION, BRUCE_WORKSPACE_PLUGIN_ID, CommandDefinition, CommandRegistryAPI, DockMode, FrontendPluginAPI (+15 more)

### Community 7 - "Architecture & Trust Model"
Cohesion: 0.07
Nodes (30): Independent Layout Persistence, No Prescribed Dock Placement, Panel Ownership and Disposal, Plugin-First Desktop Workspace, Plugin Loading Flow, Theia RPC Boundary, Services and Typed Events, Versioned Plugin Contracts (+22 more)

### Community 8 - "Workspace Core Package"
Cohesion: 0.08
Nodes (29): dependencies, @brucede/plugin-api@0.1.0, @brucede/plugin-runtime@0.1.0, @brucede/ui-kit@0.1.0, @lumino/widgets@2.7.5, @theia/core@1.77.0, description, devDependencies (+21 more)

### Community 9 - "Plugin Runtime Package"
Cohesion: 0.08
Nodes (25): dependencies, @brucede/plugin-api@0.1.0, @deepseek-ai/cordis@4.1.0, @deepseek-ai/cordis-plugin-loader@1.1.0, description, devDependencies, typescript@5.9.3, exports (+17 more)

### Community 10 - "Root Workspace Scripts"
Cohesion: 0.09
Nodes (22): devDependencies, lerna@^8.2.4, engines, node, npm, private, scripts, build:browser (+14 more)

### Community 11 - "Plugin API Package Metadata"
Cohesion: 0.10
Nodes (21): dependencies, @lumino/widgets@2.7.5, react@^19.3.1, description, devDependencies, @types/react@^19.3.0, typescript@5.9.3, exports (+13 more)

### Community 12 - "Plugin API Runtime Types"
Cohesion: 0.15
Nodes (5): react, PluginFrontendHostOptions, DOCK_MODES, HostReactWidget, PluginKernelOptions

### Community 13 - "Agent Chat Plugin Package"
Cohesion: 0.15
Nodes (15): description, devDependencies, @brucede/plugin-build@0.1.0, @brucede/plugin-api, @brucede/plugin-build, @brucede/ui-kit, name, peerDependencies (+7 more)

### Community 14 - "File Browser Plugin Package"
Cohesion: 0.15
Nodes (15): description, devDependencies, @brucede/plugin-build@0.1.0, @brucede/plugin-api, @brucede/plugin-build, @brucede/ui-kit, name, peerDependencies (+7 more)

### Community 15 - "Git Plugin Package"
Cohesion: 0.15
Nodes (15): description, devDependencies, @brucede/plugin-build@0.1.0, @brucede/plugin-api, @brucede/plugin-build, @brucede/ui-kit, name, peerDependencies (+7 more)

### Community 16 - "Terminal Plugin Package"
Cohesion: 0.15
Nodes (15): description, devDependencies, @brucede/plugin-build@0.1.0, @brucede/plugin-api, @brucede/plugin-build, @brucede/ui-kit, name, peerDependencies (+7 more)

### Community 17 - "Workspace Core TS Config"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, emitDecoratorMetadata, experimentalDecorators, lib, module, moduleResolution, noEmitOnError (+7 more)

### Community 18 - "Plugin API TS Config"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, lib, module, moduleResolution, noEmitOnError, outDir, rootDir (+5 more)

### Community 19 - "Plugin Runtime TS Config"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, lib, module, moduleResolution, noEmitOnError, outDir, rootDir (+5 more)

### Community 20 - "Demo Workspace Panels"
Cohesion: 0.19
Nodes (8): OPEN_DEMO_AGENT, OPEN_DEMO_GIT, OPEN_DEMO_LAYOUT, OPEN_DEMO_TERMINAL, WorkspaceDemoWidget, WorkspacePanelOpenOptions, RegisteredWorkspacePanel, WorkspacePanelDefinition

### Community 21 - "Canvas Shell & Plugin Manager"
Cohesion: 0.24
Nodes (3): CanvasApplicationShell, PluginEventBus, OPEN_PLUGIN_MANAGER

### Community 22 - "Host Module Rewriting"
Cohesion: 0.20
Nodes (8): escapeRegExp(), HostModuleNamespace, rewriteHostModuleSpecifiers(), HOST_MODULE_PREFIX, HOST_MODULES, PLUGIN_HOST_PATH, PluginContributionSummary, pluginHostConnectionModule

### Community 24 - "UI Kit Package"
Cohesion: 0.17
Nodes (12): description, exports, ./package.json, ./theme.css, files, @brucede/plugin-api, name, peerDependencies (+4 more)

### Community 25 - "Agent Chat Manifest"
Cohesion: 0.17
Nodes (12): apiVersion, contributes, panels, dependencies, bruce.workspace@^0.1.0, entrypoints, backend, frontend (+4 more)

### Community 26 - "File Browser Manifest"
Cohesion: 0.17
Nodes (12): apiVersion, contributes, panels, dependencies, bruce.workspace@^0.1.0, entrypoints, backend, frontend (+4 more)

### Community 27 - "Git Manifest"
Cohesion: 0.17
Nodes (12): apiVersion, contributes, panels, dependencies, bruce.workspace@^0.1.0, entrypoints, backend, frontend (+4 more)

### Community 28 - "Terminal Manifest"
Cohesion: 0.17
Nodes (12): apiVersion, contributes, panels, dependencies, bruce.workspace@^0.1.0, entrypoints, backend, frontend (+4 more)

## Knowledge Gaps
- **8 isolated node(s):** `Theia RPC Boundary`, `Independent Layout Persistence`, `Plugin-First Desktop Workspace`, `Manifest Validation`, `Optional UI Primitives` (+3 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 325 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@deepseek-ai/cordis` connect `Plugin API & Disposal Contracts` to `Plugin Runtime Package`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **What connects `Theia RPC Boundary`, `Independent Layout Persistence`, `Plugin-First Desktop Workspace` to the rest of the system?**
  _8 weakly-connected nodes found - possible missing edges._
- **Should `Plugin Host Discovery & Protocol` be split into smaller, more focused modules?**
  _Cohesion score 0.05194805194805195 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Plugin API Runtime Types` to `Plugin API Package Metadata`, `Canvas Shell & Plugin Manager`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Should `Plugin API & Disposal Contracts` be split into smaller, more focused modules?**
  _Cohesion score 0.053923541247484906 - nodes in this community are weakly interconnected._
- **Why does `PluginManager` connect `Frontend Host & Bundle Loader` to `Plugin Host Discovery & Protocol`, `Canvas Shell & Plugin Manager`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Should `Frontend Host & Bundle Loader` be split into smaller, more focused modules?**
  _Cohesion score 0.05357142857142857 - nodes in this community are weakly interconnected._