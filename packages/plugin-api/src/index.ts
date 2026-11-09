import type { Widget } from '@lumino/widgets';

export const BRUCE_PLUGIN_API_VERSION = 1 as const;

export type PluginSide = 'frontend' | 'backend';
export type PluginDisposer = () => void | Promise<void>;

export interface PluginManifest {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly apiVersion: number;
    readonly entrypoints: {
        readonly frontend?: string;
        readonly backend?: string;
    };
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly contributes?: {
        readonly panels?: readonly { readonly id: string; readonly title: string; readonly icon?: string }[];
        readonly commands?: readonly { readonly id: string; readonly title: string }[];
        readonly services?: readonly string[];
    };
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

export interface PanelDefinition {
    /** Unique within the declaring plugin. */
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
    /** Must create a fresh widget for each panel instance. */
    readonly createWidget: (instanceId: string) => Widget | Promise<Widget>;
}

export interface PanelRegistryAPI {
    register(definition: PanelDefinition): PluginDisposer;
    open(panelId: string, options?: PanelOpenOptions): Promise<string>;
    close(instanceId: string): Promise<void>;
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
    onDispose(disposer: PluginDisposer): void;
}

export interface FrontendPluginAPI extends PluginAPIBase {
    readonly panels: PanelRegistryAPI;
    readonly commands: CommandRegistryAPI;
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
