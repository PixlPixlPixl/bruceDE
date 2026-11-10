import type { Widget } from '@lumino/widgets';

/**
 * Version of the host/plugin contract. A plugin declaring an unsupported
 * `apiVersion` is rejected before any of its code is imported.
 */
export const BRUCE_PLUGIN_API_VERSION = 1 as const;

export type PluginSide = 'frontend' | 'backend';
export type PluginDisposer = () => void | Promise<void>;

/** Identifiers that are always available from the host, never loaded as plugins. */
export const BRUCE_WORKSPACE_PLUGIN_ID = 'bruce.workspace';

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
    /** Globally unique, namespaced identifier, e.g. `bruce.terminal`. */
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** Must equal a {@link BRUCE_PLUGIN_API_VERSION} the host supports. */
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

export interface PanelOpenOptions {
    readonly ref?: string;
    readonly mode?: DockMode;
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
     */
    readonly createWidget: (instanceId: string, host: PanelHostTools) => Widget | Promise<Widget>;
}

export interface PanelRegistryAPI {
    register(definition: PanelDefinition): PluginDisposer;
    open(panelId: string, options?: PanelOpenOptions): Promise<string>;
    close(instanceId: string): Promise<void>;
    /** Instance ids opened by this plugin that are still open. */
    getOpenInstances(): readonly string[];
}

export interface ServiceRegistryAPI {
    provide<T>(serviceId: string, service: T): PluginDisposer;
    get<T>(serviceId: string): T;
    has(serviceId: string): boolean;
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
