import * as React from 'react';
import * as luminoWidgets from '@lumino/widgets';
import type { Widget } from '@lumino/widgets';
import type {
    CommandDefinition,
    DockMode,
    FrontendPluginAPI,
    HostPanelRegistration,
    PanelDefinition,
    PanelHostTools,
    PanelOpenOptions,
    PluginDisposer,
    PluginManifest,
    RemoteService
} from '@brucede/plugin-api';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import type { Message } from '@theia/core/lib/browser/widgets/widget';
import type { DisposerBag } from '@brucede/plugin-runtime';
import { PluginEventBus, PluginServiceRegistry } from '../../common/plugin-registries.js';
import { WorkspaceDockingService } from '../workspace-docking-service.js';
import { WorkspacePanelRegistry } from '../workspace-panel-registry.js';
import type { HostPanelFactoryRegistry } from '../host-panels/host-panel-factory-registry.js';

// The registries are framework-free so the Node backend shares the same
// semantics; re-exported here because the renderer kernel is their public home.
export { PluginEventBus, PluginServiceRegistry };

/**
 * A widget whose body is a host-rendered React element.
 *
 * `ReactWidget` only paints in `onUpdateRequest`, and nothing schedules one on
 * its own: Lumino attaches the widget without asking for an update. Without the
 * explicit `update()` below a plugin panel attaches as an empty node, which
 * looks like a blank white panel.
 */
class HostReactWidget extends ReactWidget {
    constructor(private readonly elementFactory: () => React.ReactNode) {
        super();
        this.addClass('bruce-plugin-panel');
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.update();
    }

    protected render(): React.ReactNode {
        return this.elementFactory();
    }
}

export interface PluginKernelOptions {
    readonly panelRegistry: WorkspacePanelRegistry;
    readonly docking: WorkspaceDockingService;
    readonly commands: CommandRegistry;
    readonly services: PluginServiceRegistry;
    readonly events: PluginEventBus;
    /** Curated host capabilities a plugin may adopt without importing Theia. */
    readonly hostPanelFactories: HostPanelFactoryRegistry;
    /**
     * Invokes a service provided by a backend plugin over Theia's RPC channel.
     * When absent, `api.services.remote` reports that no bridge is configured.
     */
    readonly invokeRemote?: (
        serviceId: string,
        method: string,
        args: readonly unknown[]
    ) => Promise<unknown>;
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
        const { panelRegistry, docking, commands, services, events, hostPanelFactories } = this.options;

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
            registerHostPanel: (registration: HostPanelRegistration): PluginDisposer => {
                if (!hostPanelFactories.has(registration.capabilityId)) {
                    throw new Error(
                        `Host panel capability "${registration.capabilityId}" is not available in this build.`
                    );
                }
                const typeId = panelTypeId(registration.id);
                const unregister = panelRegistry.registerPanel(
                    {
                        id: typeId,
                        title: registration.title,
                        // The host builds and owns the widget; the plugin only
                        // names the capability and never sees a raw host widget.
                        hostPanel: true,
                        createWidget: instanceId =>
                            hostPanelFactories.create(registration.capabilityId, {
                                capabilityId: registration.capabilityId,
                                instanceId,
                                options: registration.options
                            })
                    },
                    pluginId
                );
                const dispose = () => {
                    unregister();
                };
                bag.add(dispose);
                return dispose;
            },
            hasHostCapability: (capabilityId: string): boolean => hostPanelFactories.has(capabilityId),
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
            has: (serviceId: string) => services.has(serviceId),
            remote: <T>(serviceId: string): RemoteService<T> => this.remoteService(serviceId)
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
     * Builds a proxy whose every method invocation becomes one RPC call into a
     * backend plugin's service. Arguments and results must be JSON-serializable.
     */
    protected remoteService<T>(serviceId: string): RemoteService<T> {
        const invoke = this.options.invokeRemote;
        const proxy = new Proxy({}, {
            get: (_target, property) => {
                if (typeof property !== 'string') {
                    return undefined;
                }
                return async (...args: readonly unknown[]): Promise<unknown> => {
                    if (!invoke) {
                        throw new Error(
                            `Service "${serviceId}" is remote, but no plugin service bridge is configured.`
                        );
                    }
                    return invoke(serviceId, property, args);
                };
            }
        });
        return proxy as RemoteService<T>;
    }

    /**
     * Releases host-side contributions for a plugin. Cordis disposers normally
     * handle this; this is the belt-and-suspenders sweep for state keyed by owner.
     */
    releaseOwner(pluginId: string): void {
        this.options.services.removeByOwner(pluginId);
        this.options.events.removeByOwner(pluginId);
    }
}
