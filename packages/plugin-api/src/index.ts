import type { Widget } from '@lumino/widgets';

/**
 * Version of the host/plugin contract. A plugin declaring an unsupported
 * `apiVersion` is rejected before any of its code is imported.
 */
export const ICEBOX_PLUGIN_API_VERSION = 1 as const;

export type PluginSide = 'frontend' | 'backend';
export type PluginDisposer = () => void | Promise<void>;

/** Identifiers that are always available from the host, never loaded as plugins. */
export const ICEBOX_WORKSPACE_PLUGIN_ID = 'icebox.workspace';

/**
 * Stable service ids. Host services are provided under
 * `ICEBOX_WORKSPACE_PLUGIN_ID` before any plugin activates; first-party feature
 * plugins provide the rest.
 *
 * Service ids are part of the public contract: renaming one is a breaking
 * change and requires an `apiVersion` bump.
 */
export const WORKSPACE_SERVICE_IDS = {
    /** {@link WorkspaceResourcesService}: URI-based resource identity and metadata. */
    resources: 'workspace.resources',
    /** {@link WorkspaceSelectionService}: the user's current workspace selection. */
    selection: 'workspace.selection',
    /** {@link WorkspaceDialogsService}: native host dialogs a plugin may request. */
    dialogs: 'workspace.dialogs',
    /** Repository state provided by the Git plugin. */
    gitRepository: 'git.repository',
    /** Agent sessions provided by the agent-chat plugin. */
    agentSessions: 'agent.sessions',
    /**
     * {@link AgentChatLauncherService}, provided by the agent-chat plugin on the
     * renderer side. Other plugins use it to open a chat they do not own; panel
     * ids are namespaced per plugin, so {@link PanelRegistryAPI.open} cannot.
     */
    agentChat: 'agent.chat'
} as const;

/** Stable event names emitted through `api.events`. */
export const WORKSPACE_EVENT_IDS = {
    /** Payload: {@link ResourceSelection} or `undefined`. */
    selectionChanged: 'workspace/selection-changed',
    /** Payload: repository change set provided by the Git plugin. */
    changesUpdated: 'git/changes-updated',
    /**
     * Payload: {@link AgentSessionChange}. Emitted by the agent-chat backend when
     * a live session starts, binds its native handle, finishes a turn or is
     * released, so a workspace plugin can persist its state without polling.
     */
    agentSessionChanged: 'agent/session-changed'
} as const;

/**
 * Stable identity of a workspace resource.
 *
 * Renderer and backend refer to the same resource by the same string, so
 * resource URIs must never be constructed ad hoc: use
 * `WorkspaceResourcesService.fromPath` from the host.
 */
export type ResourceUri = string;

/** Zero-based position inside a resource. */
export interface ResourcePosition {
    readonly line: number;
    readonly character: number;
}

/** Half-open range inside a resource. */
export interface ResourceRange {
    readonly start: ResourcePosition;
    readonly end: ResourcePosition;
}

/** A resource together with the ranges the user currently cares about. */
export interface ResourceSelection {
    readonly uri: ResourceUri;
    readonly ranges: readonly ResourceRange[];
}

export type ResourceKind = 'file' | 'directory' | 'unknown';

/** Metadata for one resource. */
export interface ResourceStat {
    readonly uri: ResourceUri;
    readonly name: string;
    readonly kind: ResourceKind;
    readonly children?: readonly ResourceStat[];
}

/**
 * Resource identity and metadata, provided by the host as
 * {@link WORKSPACE_SERVICE_IDS.resources}.
 */
export interface WorkspaceResourcesService {
    /** Absolute filesystem path → stable resource URI. */
    fromPath(absolutePath: string): ResourceUri;
    stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
    /** Direct children of a directory resource. */
    list(uri: ResourceUri): Promise<readonly ResourceStat[]>;
}

/**
 * Shared selection state, provided by the host as
 * {@link WORKSPACE_SERVICE_IDS.selection}.
 */
export interface WorkspaceSelectionService {
    get(): ResourceSelection | undefined;
    set(selection: ResourceSelection | undefined): void;
    onDidChange(listener: (selection: ResourceSelection | undefined) => void): PluginDisposer;
}

/**
 * Native dialogs, provided by the host as
 * {@link WORKSPACE_SERVICE_IDS.dialogs}.
 *
 * Plugins must not build their own OS-level pickers (or import Theia's file
 * dialog): the host owns the modal, its parent window and its platform quirks.
 */
export interface WorkspaceDialogsService {
    /**
     * Shows the host's folder picker and resolves to an absolute filesystem path.
     * Resolves `undefined` when the user cancels.
     */
    pickDirectory(options?: { readonly title?: string }): Promise<string | undefined>;
}

/**
 * Wire protocol a chat session speaks.
 *
 * `agui` is the AG-UI protocol — one HTTP POST per turn answering with a stream
 * of Server-Sent Events — and is the interface the panel prefers. `acp` and
 * `pi-rpc` are the agents' own stdio protocols, used when an agent has no AG-UI
 * endpoint or its endpoint does not answer.
 */
export type AgentProtocol = 'acp' | 'pi-rpc' | 'agui';

/** Human-readable name of a protocol, for the panel's label and tooltips. */
export const AGENT_PROTOCOL_LABELS: Record<AgentProtocol, string> = {
    agui: 'AG-UI',
    acp: 'ACP',
    'pi-rpc': 'Pi RPC'
};

/**
 * True for a protocol this API version knows.
 *
 * A plugin that stores an agent session handle validates it with this instead of
 * listing protocols itself, so a new protocol is accepted by every consumer as
 * soon as `plugin-api` knows it. Projects used to keep its own `acp`/`pi-rpc`
 * list, which silently dropped AG-UI handles and would have lost every AG-UI
 * session on the next store write.
 */
export function isAgentProtocol(value: unknown): value is AgentProtocol {
    return value === 'agui' || value === 'acp' || value === 'pi-rpc';
}

/** Liveness of one agent session. */
export type AgentStatus = 'idle' | 'starting' | 'running' | 'error';

/** One agent executable the agent-chat backend can control. */
export interface AgentDescriptor {
    readonly id: string;
    readonly name: string;
    /**
     * The agent's own protocol, used when it has no AG-UI endpoint or when none
     * answers. An agent reachable only over AG-UI leaves `command` empty.
     */
    readonly protocol: AgentProtocol;
    readonly command: string;
    readonly args: readonly string[];
    /**
     * HTTP endpoint of the agent's AG-UI server, when it has one.
     *
     * AG-UI is tried first for every agent that declares an endpoint, because it
     * is the interface the panel prefers; the protocol above is the fallback for
     * when the endpoint does not answer. `ICEBOX_AGUI_URL` supplies a default for
     * agents that do not declare their own.
     */
    readonly agui?: string;
    /** False when the executable is not on `PATH`; shown as unavailable. */
    readonly available: boolean;
}

/**
 * The agent's own handle for a conversation, so it can be continued later.
 *
 * These values are opaque tokens owned by the agent CLI: a workspace plugin
 * stores them verbatim and hands them back through
 * {@link AgentSessionOptions.resume}. Resuming must go through the agent's
 * native mechanism (`--session` for Pi, `session/load` for ACP) so its own
 * context and prompt cache stay intact.
 */
export interface AgentSessionHandle {
    readonly agentId: string;
    readonly protocol: AgentProtocol;
    /** The session id the agent itself uses. */
    readonly sessionId: string;
    /** Pi persists a session as a JSONL file; resuming by path works from any directory. */
    readonly sessionFile?: string;
}

/** Extra binding options of the agent sessions service's session opening call. */
export interface AgentSessionOptions {
    /** Working directory the agent runs in; defaults to the workspace directory. */
    readonly cwd?: string;
    /** Native handle of an earlier conversation this session should continue. */
    readonly resume?: AgentSessionHandle;
}

/**
 * Cheap snapshot of one live agent session.
 *
 * Unlike a full transcript this is safe to poll, which is how a session list
 * keeps status and titles current.
 */
export interface AgentSessionSummary {
    readonly sessionId: string;
    readonly agentId: string;
    readonly status: AgentStatus;
    /** False when the backend has no live session under this id. */
    readonly live: boolean;
    readonly cwd?: string;
    /** First line of the first prompt, when the session has one. */
    readonly title?: string;
    readonly resume?: AgentSessionHandle;
    /** ISO timestamp of the last observed change. */
    readonly updatedAt?: string;
}

/** Payload of {@link WORKSPACE_EVENT_IDS.agentSessionChanged}. */
export interface AgentSessionChange {
    readonly sessionId: string;
}

/** Options for {@link AgentChatLauncherService.openChat}. */
export interface AgentChatOpenOptions {
    readonly agentId: string;
    /** Folder the agent runs in; omitted means the workspace directory. */
    readonly cwd?: string;
    /**
     * Logical session id used by the backend for this conversation.
     *
     * The panel instance id is chosen by the host, so a caller that wants to
     * address the session later (a project list does) must supply its own id.
     */
    readonly sessionId?: string;
    /** Native handle to continue an earlier conversation. */
    readonly resume?: AgentSessionHandle;
    /** Tab label; defaults to the agent name. */
    readonly title?: string;
}

/**
 * Renderer-side launcher of agent chat panels, provided by the agent-chat plugin
 * as {@link WORKSPACE_SERVICE_IDS.agentChat}.
 *
 * Resolves with the new panel instance id. The chat keeps running when the
 * calling plugin unloads: it is owned by agent-chat, not by the launcher.
 */
export interface AgentChatLauncherService {
    openChat(options: AgentChatOpenOptions): Promise<string>;
}

export interface PluginManifestContributionPanels {
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
}

export interface PluginManifestContributionCommands {
    readonly id: string;
    readonly title: string;
}

export interface PluginManifestContributions {
    /**
     * Panel types this plugin intends to register. Declaring them here lets the
     * host report the plugin's capabilities before activation; the authoritative
     * registration still happens through `api.panels.register`.
     */
    readonly panels?: readonly PluginManifestContributionPanels[];
    /** Commands this plugin intends to register. */
    readonly commands?: readonly PluginManifestContributionCommands[];
    /** Service identifiers this plugin intends to provide. */
    readonly services?: readonly string[];
}

export interface PluginManifest {
    /** Globally unique, namespaced identifier, e.g. `icebox.terminal`. */
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** Must equal a {@link ICEBOX_PLUGIN_API_VERSION} the host supports. */
    readonly apiVersion: number;
    readonly description?: string;
    /** Module paths relative to the plugin folder. */
    readonly entrypoints: {
        readonly frontend?: string;
        readonly backend?: string;
    };
    /** Plugin id → semver range of required plugins. */
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly contributes?: PluginManifestContributions;
}

export type DockMode =
    | 'split-left'
    | 'split-right'
    | 'split-top'
    | 'split-bottom'
    | 'tab-before'
    | 'tab-after';

/**
 * JSON-serialisable data a panel instance carries.
 *
 * The host persists it with the widget layout and hands it back when the panel is
 * rebuilt, so an instance can remember what it was opened for (which agent a
 * chat tab talks to, which file a viewer shows, and so on). Only plain JSON
 * values are accepted: anything else could not survive a restart.
 */
export type PanelState = { readonly [key: string]: unknown };

export interface PanelOpenOptions {
    readonly ref?: string;
    readonly mode?: DockMode;
    /** Instance state passed to {@link PanelDefinition.createWidget}. */
    readonly state?: PanelState;
}

/**
 * Host capabilities handed to a panel factory.
 *
 * Panels must be built from *these* objects rather than importing Lumino or
 * React directly: a plugin bundle that bundles its own copy would produce
 * widgets/roots the host shell cannot adopt.
 */
export interface PanelHostTools {
    /** The host renderer's React runtime. */
    readonly React: typeof import('react');
    /** The host renderer's Lumino widget module (same classes the shell uses). */
    readonly widgets: typeof import('@lumino/widgets');
    /** Create a widget whose body is a host-rendered React element. */
    createReactWidget(render: () => React.ReactNode): Widget;
}

export interface PanelDefinition {
    /** Unique within the declaring plugin. */
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
    /**
     * Creates a fresh widget for each panel instance. The host owns disposal:
     * once the owning plugin unloads the shell closes every instance it opened.
     *
     * `state` is whatever the opening caller passed to `panels.open`, restored
     * from the saved layout when the instance is rebuilt after a restart.
     */
    readonly createWidget: (
        instanceId: string,
        host: PanelHostTools,
        state?: PanelState
    ) => Widget | Promise<Widget>;
}

/**
 * Stable host panel capabilities a plugin may adopt through
 * {@link PanelRegistryAPI.registerHostPanel}.
 *
 * These ids are **capability contracts**, not import paths, module names or
 * Theia class names. A plugin never receives a raw host widget, a DI container
 * or a `WidgetManager`: the host builds the widget behind the capability and
 * hands back a panel instance. The host therefore stays free to change how a
 * capability is implemented without breaking plugins, and a missing capability
 * is reported instead of faked.
 */
export const HOST_PANEL_CAPABILITIES = {
    /** Interactive terminal backed by the host's native terminal widget. */
    terminal: 'icebox.terminal'
} as const;

export type HostPanelCapabilityId =
    (typeof HOST_PANEL_CAPABILITIES)[keyof typeof HOST_PANEL_CAPABILITIES];

/** A panel type backed by a host capability instead of a plugin-built widget. */
export interface HostPanelRegistration {
    /** Unique within the declaring plugin; becomes `<pluginId>:<id>`. */
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
    /**
     * Stable capability id, for example {@link HOST_PANEL_CAPABILITIES.terminal}.
     * Never a module path or a Theia class name.
     */
    readonly capabilityId: string;
    /** JSON-serializable, capability-specific options. */
    readonly options?: Readonly<Record<string, unknown>>;
}

export interface PanelRegistryAPI {
    register(definition: PanelDefinition): PluginDisposer;
    /**
     * Registers a panel type the host builds on your behalf.
     *
     * Use this for native functionality (a terminal, an editor, …) instead of
     * importing Theia internals into the plugin bundle. The host keeps ownership
     * of the widget and of its creation path, so the same host code creates
     * panels opened by a plugin and by the host's own commands.
     */
    registerHostPanel(registration: HostPanelRegistration): PluginDisposer;
    /** True when the host currently exposes `capabilityId`. */
    hasHostCapability(capabilityId: string): boolean;
    /**
     * Opens a panel instance in the shared main DockPanel.
     *
     * Panels are created through the host's `WidgetManager`, so the shell can
     * persist and restore them together with the rest of the workspace layout.
     */
    open(panelId: string, options?: PanelOpenOptions): Promise<string>;
    close(instanceId: string): Promise<void>;
    /** Instance ids opened by this plugin that are still open. */
    getOpenInstances(): readonly string[];
}

/**
 * A service that lives on the other side of the RPC boundary.
 *
 * Every method resolves asynchronously, because each call crosses Theia's
 * backend channel. Arguments and results must be JSON-serializable.
 */
export type RemoteService<T> = {
    readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
        ? (...args: A) => Promise<Awaited<R>>
        : never;
};

export interface ServiceRegistryAPI {
    provide<T>(serviceId: string, service: T): PluginDisposer;
    get<T>(serviceId: string): T;
    has(serviceId: string): boolean;
    /**
     * Resolves a service a *backend* plugin provided, from the renderer.
     *
     * The call travels over Theia's existing backend channel — no extra process
     * or socket is opened. Calling this from a backend plugin throws, because
     * the bridge is renderer → backend only.
     */
    remote<T>(serviceId: string): RemoteService<T>;
}

export interface PluginEventAPI {
    on<T>(eventName: string, listener: (payload: T) => void | Promise<void>): PluginDisposer;
    emit<T>(eventName: string, payload: T): void;
}

export interface CommandDefinition {
    readonly id: string;
    readonly title: string;
    readonly execute: (...args: readonly unknown[]) => unknown | Promise<unknown>;
}

export interface CommandRegistryAPI {
    register(command: CommandDefinition): PluginDisposer;
}

export interface PluginAPIBase {
    readonly manifest: PluginManifest;
    readonly side: PluginSide;
    readonly services: ServiceRegistryAPI;
    readonly events: PluginEventAPI;
    /** Where this plugin was discovered, and whether the user trusted it. */
    readonly origin: PluginOrigin;
    /** Registers a disposal callback that runs when the plugin unloads. */
    onDispose(disposer: PluginDisposer): void;
}

export interface PluginOrigin {
    readonly builtIn: boolean;
    /** Absolute folder the plugin was loaded from. */
    readonly directory: string;
}

export interface FrontendPluginAPI extends PluginAPIBase {
    readonly panels: PanelRegistryAPI;
    readonly commands: CommandRegistryAPI;
    /** Shared host UI primitives for panel construction. */
    readonly ui: PanelHostTools;
}

export interface BackendPluginAPI extends PluginAPIBase {
    /** Host workspace paths and project context; direct Node APIs remain available. */
    readonly workspace: { readonly root?: string; readonly cwd: string };
}

export interface FrontendPluginModule {
    activate(api: FrontendPluginAPI): void | PluginDisposer | Promise<void | PluginDisposer>;
}

export interface BackendPluginModule {
    activate(api: BackendPluginAPI): void | PluginDisposer | Promise<void | PluginDisposer>;
}
