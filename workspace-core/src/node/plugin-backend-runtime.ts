import { pathToFileURL } from 'url';
import type { BackendPluginAPI, PluginManifest, RemoteService } from '@brucede/plugin-api';
import { CordisPluginManager, type DisposerBag, type PluginRuntimeState } from '@brucede/plugin-runtime';
import { PluginEventBus, PluginServiceRegistry } from '../common/plugin-registries.js';
import type { DiscoveredPlugin } from './plugin-discovery.js';

export interface PluginBackendLogger {
    info(message: string): void;
    error(message: string): void;
}

export interface PluginBackendRuntimeOptions {
    readonly isTrusted: (pluginId: string) => boolean;
    readonly logger: PluginBackendLogger;
}

interface BackendRecord {
    state: PluginRuntimeState;
    error?: string;
}

/**
 * Runs backend plugin modules inside the normal Node backend process.
 *
 * The backend plugin API is deliberately small: services, typed events,
 * workspace paths and disposal. Plugins still have unrestricted Node access —
 * that is disclosed by the trust warning rather than fenced off here.
 */
export class PluginBackendRuntime {
    private readonly manager = new CordisPluginManager<BackendPluginAPI>({
        onError: (manifest, error) => {
            this.options.logger.error(
                `[plugin-host] Backend plugin "${manifest.id}" failed: ${describeError(error)}`
            );
        }
    });

    private readonly records = new Map<string, BackendRecord>();

    /**
     * One registry for the whole backend process, exactly like the renderer's.
     * A per-plugin registry would make backend plugins invisible to each other.
     *
     * It is exposed because the RPC service bridge resolves remote calls
     * through it.
     */
    readonly services = new PluginServiceRegistry();
    private readonly events = new PluginEventBus();

    constructor(private readonly options: PluginBackendRuntimeOptions) { }

    /** Activates a discovered plugin's backend entrypoint, if it has one. */
    async load(plugin: DiscoveredPlugin): Promise<void> {
        const { manifest, backendEntrypoint } = plugin;
        if (!backendEntrypoint) {
            return;
        }
        if (!this.options.isTrusted(manifest.id)) {
            this.records.set(manifest.id, {
                state: 'failed',
                error: 'Plugin is not trusted; backend module was not imported.'
            });
            return;
        }

        this.records.set(manifest.id, { state: 'loading' });
        const record = await this.manager.load<BackendPluginAPI>({
            manifest,
            loadModule: () => importBackendModule(backendEntrypoint),
            createApi: (_ctx, bag) => createBackendApi(manifest, plugin.directory, bag, this.services, this.events)
        });
        this.records.set(manifest.id, {
            state: record.state,
            error: record.error === undefined ? undefined : describeError(record.error)
        });
        if (record.state === 'active') {
            this.options.logger.info(`[plugin-host] Backend plugin "${manifest.id}" activated.`);
        }
    }

    async unload(pluginId: string): Promise<void> {
        // Drop owner-keyed state first: a service must stop being resolvable
        // before the fiber that provided it is disposed.
        this.services.removeByOwner(pluginId);
        this.events.removeByOwner(pluginId);
        await this.manager.unload(pluginId);
        this.records.delete(pluginId);
    }

    async unloadAll(): Promise<void> {
        await this.manager.unloadAll();
        this.records.clear();
    }

    getState(pluginId: string): BackendRecord | undefined {
        return this.records.get(pluginId);
    }
}

/**
 * Imports a backend ESM bundle by absolute path. `import()` of a `file://` URL
 * is the only supported mechanism; the bundled path is already validated to be
 * inside the plugin folder.
 */
async function importBackendModule(absolutePath: string): Promise<unknown> {
    return import(pathToFileURL(absolutePath).href);
}

function createBackendApi(
    manifest: PluginManifest,
    directory: string,
    bag: DisposerBag,
    serviceRegistry: PluginServiceRegistry,
    eventBus: PluginEventBus
): BackendPluginAPI {
    const owner = manifest.id;
    return {
        manifest,
        side: 'backend',
        services: {
            provide: <T>(serviceId: string, service: T) => {
                const disposer = serviceRegistry.provide(owner, serviceId, service);
                bag.add(disposer);
                return disposer;
            },
            get: <T>(serviceId: string) => serviceRegistry.get<T>(serviceId),
            has: (serviceId: string) => serviceRegistry.has(serviceId),
            // The bridge carries renderer → backend calls only. A backend plugin
            // consumes another backend plugin's service directly, in-process.
            remote: <T>(serviceId: string): RemoteService<T> => {
                throw new Error(
                    `Service "${serviceId}" cannot be resolved remotely from the backend. `
                    + 'Use api.services.get for backend services.'
                );
            }
        },
        events: {
            on: <T>(eventName: string, listener: (payload: T) => void | Promise<void>) => {
                const disposer = eventBus.on(owner, eventName, listener);
                bag.add(disposer);
                return disposer;
            },
            emit: <T>(eventName: string, payload: T) => eventBus.emit(eventName, payload)
        },
        origin: { builtIn: !directory.includes('.brucede'), directory },
        workspace: { cwd: process.cwd(), root: process.cwd() },
        onDispose: disposer => {
            bag.add(disposer);
        }
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
