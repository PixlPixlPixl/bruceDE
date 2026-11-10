import * as React from 'react';
import * as luminoWidgets from '@lumino/widgets';
import type { Widget } from '@lumino/widgets';
import type {
    CommandDefinition,
    DockMode,
    FrontendPluginAPI,
    PanelDefinition,
    PanelHostTools,
    PanelOpenOptions,
    PluginDisposer,
    PluginManifest
} from '@brucede/plugin-api';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import type { DisposerBag } from '@brucede/plugin-runtime';
import { WorkspaceDockingService } from '../workspace-docking-service.js';
import { WorkspacePanelRegistry } from '../workspace-panel-registry.js';

/** A widget whose body is a host-rendered React element. */
class HostReactWidget extends ReactWidget {
    constructor(private readonly elementFactory: () => React.ReactNode) {
        super();
        this.addClass('bruce-plugin-panel');
    }

    protected render(): React.ReactNode {
        return this.elementFactory();
    }
}

/**
 * Services shared by every plugin in the renderer.
 *
 * One registry is used for all plugins so a plugin can consume another plugin's
 * service, and `provide` links each entry to its owner so unloading the owner
 * removes exactly its own contributions.
 */
export class PluginServiceRegistry {
    private readonly services = new Map<string, { readonly owner: string; readonly value: unknown }>();

    provide<T>(owner: string, serviceId: string, service: T): PluginDisposer {
        if (this.services.has(serviceId)) {
            throw new Error(`Service already provided: ${serviceId}`);
        }
        this.services.set(serviceId, { owner, value: service });
        return () => {
            if (this.services.get(serviceId)?.owner === owner) {
                this.services.delete(serviceId);
            }
        };
    }

    get<T>(serviceId: string): T {
        const entry = this.services.get(serviceId);
        if (!entry) {
            throw new Error(`Unknown service: ${serviceId}`);
        }
        return entry.value as T;
    }

    has(serviceId: string): boolean {
        return this.services.has(serviceId);
    }

    /** Removes every service a plugin provided. */
    removeByOwner(owner: string): void {
        for (const [serviceId, entry] of Array.from(this.services.entries())) {
            if (entry.owner === owner) {
                this.services.delete(serviceId);
            }
        }
    }
}

/** Typed event bus shared by every plugin in the renderer. */
export class PluginEventBus {
    private readonly listeners = new Map<string, Set<{ owner: string; listener: (payload: unknown) => void | Promise<void> }>>();

    on<T>(owner: string, eventName: string, listener: (payload: T) => void | Promise<void>): PluginDisposer {
        const entry = { owner, listener: listener as (payload: unknown) => void | Promise<void> };
        let set = this.listeners.get(eventName);
        if (!set) {
            set = new Set();
            this.listeners.set(eventName, set);
        }
        set.add(entry);
        return () => {
            const current = this.listeners.get(eventName);
            current?.delete(entry);
            if (current && current.size === 0) {
                this.listeners.delete(eventName);
            }
        };
    }

    emit<T>(eventName: string, payload: T): void {
        for (const { listener } of this.listeners.get(eventName) ?? []) {
            try {
                void listener(payload);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[plugin-host] Listener for "${eventName}" threw:`, error);
            }
        }
    }

    removeByOwner(owner: string): void {
        for (const [eventName, set] of Array.from(this.listeners.entries())) {
            for (const entry of Array.from(set)) {
                if (entry.owner === owner) {
                    set.delete(entry);
                }
            }
            if (set.size === 0) {
                this.listeners.delete(eventName);
            }
        }
    }
}

export interface PluginKernelOptions {
    readonly panelRegistry: WorkspacePanelRegistry;
    readonly docking: WorkspaceDockingService;
    readonly commands: CommandRegistry;
    readonly services: PluginServiceRegistry;
    readonly events: PluginEventBus;
}

const DOCK_MODES: Readonly<Record<DockMode, NonNullable<PanelOpenOptions['mode']>>> = {
    'split-left': 'split-left',
    'split-right': 'split-right',
    'split-top': 'split-top',
    'split-bottom': 'split-bottom',
    'tab-before': 'tab-before',
    'tab-after': 'tab-after'
};

/**
 * Builds the `FrontendPluginAPI` object handed to a plugin's `activate`.
 *
 * Every registration goes through the plugin's {@link DisposerBag}, so a
 * plugin that forgets to return a disposer still releases everything it
 * registered when the host unloads it.
 */
export class PluginKernel {
    constructor(private readonly options: PluginKernelOptions) { }

    readonly panelHostTools: PanelHostTools = {
        React,
        widgets: luminoWidgets,
        createReactWidget: (render: () => React.ReactNode): Widget => new HostReactWidget(render)
    };

    createApi(manifest: PluginManifest, directory: string, bag: DisposerBag): FrontendPluginAPI {
        const pluginId = manifest.id;
        const instanceIds = new Set<string>();
        const { panelRegistry, docking, commands, services, events } = this.options;

        const panelTypeId = (panelId: string): string => `${pluginId}:${panelId}`;

        const panels: FrontendPluginAPI['panels'] = {
            register: (definition: PanelDefinition): PluginDisposer => {
                const typeId = panelTypeId(definition.id);
                const unregister = panelRegistry.registerPanel(
                    {
                        id: typeId,
                        title: definition.title,
                        createWidget: instanceId => definition.createWidget(instanceId, this.panelHostTools)
                    },
                    pluginId
                );
                const dispose = () => {
                    unregister();
                };
                bag.add(dispose);
                return dispose;
            },
            open: async (panelId: string, options: PanelOpenOptions = {}) => {
                const mode = options.mode ? DOCK_MODES[options.mode] : undefined;
                const ref = options.ref ? docking.getWidgetById(options.ref) : undefined;
                const widget = await docking.openPanel(panelTypeId(panelId), { ref, mode });
                instanceIds.add(widget.id);
                widget.disposed.connect(() => instanceIds.delete(widget.id));
                return widget.id;
            },
            close: async (instanceId: string) => {
                await docking.closePanel(instanceId);
                instanceIds.delete(instanceId);
            },
            getOpenInstances: () => Array.from(instanceIds)
        };

        const pluginCommands: FrontendPluginAPI['commands'] = {
            register: (command: CommandDefinition): PluginDisposer => {
                if (commands.getCommand(command.id)) {
                    throw new Error(`Command "${command.id}" is already registered.`);
                }
                const disposable = commands.registerCommand(
                    { id: command.id, label: command.title },
                    { execute: (...args: unknown[]) => command.execute(...args) }
                );
                const dispose = () => disposable.dispose();
                bag.add(dispose);
                return dispose;
            }
        };

        const pluginServices: FrontendPluginAPI['services'] = {
            provide: <T>(serviceId: string, service: T) => {
                const dispose = services.provide(pluginId, serviceId, service);
                bag.add(dispose);
                return dispose;
            },
            get: <T>(serviceId: string) => services.get<T>(serviceId),
            has: (serviceId: string) => services.has(serviceId)
        };

        const pluginEvents: FrontendPluginAPI['events'] = {
            on: <T>(eventName: string, listener: (payload: T) => void | Promise<void>) => {
                const dispose = events.on(pluginId, eventName, listener);
                bag.add(dispose);
                return dispose;
            },
            emit: <T>(eventName: string, payload: T) => events.emit(eventName, payload)
        };

        return {
            manifest,
            side: 'frontend',
            panels,
            commands: pluginCommands,
            services: pluginServices,
            events: pluginEvents,
            ui: this.panelHostTools,
            origin: { builtIn: !directory.includes('.brucede'), directory },
            onDispose: (disposer: PluginDisposer) => {
                bag.add(disposer);
            }
        };
    }

    /**
     * Releases host-side contributions for a plugin. Cordis disposers normally
     * handle this; this is the belt-and-braces sweep for state keyed by owner.
     */
    releaseOwner(pluginId: string): void {
        this.options.services.removeByOwner(pluginId);
        this.options.events.removeByOwner(pluginId);
    }
}
