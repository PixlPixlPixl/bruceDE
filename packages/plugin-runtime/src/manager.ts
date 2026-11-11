import { Context, type Fiber } from '@deepseek-ai/cordis';
import type {
    BackendPluginAPI,
    BackendPluginModule,
    FrontendPluginAPI,
    FrontendPluginModule,
    PluginDisposer,
    PluginManifest
} from '@icebox/plugin-api';
import { DisposerBag, toDisposer } from './disposal.js';

/** Any plugin side module shape the runtime can activate. */
export type PluginModule = FrontendPluginModule | BackendPluginModule;

/** Loading state reported for a plugin managed by {@link CordisPluginManager}. */
export type PluginRuntimeState = 'idle' | 'loading' | 'active' | 'failed' | 'disposed';

export interface PluginRuntimeRecord {
    readonly manifest: PluginManifest;
    readonly state: PluginRuntimeState;
    readonly fiber?: Fiber;
    readonly error?: unknown;
}

export interface PluginLoadRequest<TApi> {
    readonly manifest: PluginManifest;
    /** Dynamic import of the already-validated ESM entrypoint. */
    readonly loadModule: () => Promise<unknown>;
    /** Builds the API object handed to the plugin's `activate`. */
    readonly createApi: (ctx: Context, bag: DisposerBag) => TApi;
}

export interface CordisPluginManagerOptions {
    /** Reuse an existing context instead of creating a root context. */
    readonly context?: Context;
    /** Called for failures that Cordis would otherwise only log. */
    readonly onError?: (manifest: PluginManifest, error: unknown) => void;
}

/**
 * Hosts plugin modules inside Cordis fibers.
 *
 * Cordis owns per-plugin activation and disposal: a fiber's effects are torn
 * down in reverse order when the plugin unloads, on failure, and when the
 * owning context is disposed. The manager adds the pieces Cordis does not know
 * about — resolving the module's `activate` export, running it with a typed
 * API, and draining disposers registered imperatively through the API.
 */
export class CordisPluginManager<TApi extends FrontendPluginAPI | BackendPluginAPI> {
    readonly root: Context;
    private readonly records = new Map<string, PluginRuntimeRecord>();
    private readonly fibers = new Map<string, Fiber>();
    private readonly onError: (manifest: PluginManifest, error: unknown) => void;

    constructor(options: CordisPluginManagerOptions = {}) {
        this.root = options.context ?? new Context();
        this.onError = options.onError ?? ((manifest, error) => {
            // eslint-disable-next-line no-console
            console.error(`[plugin-runtime] "${manifest.id}" failed:`, error);
        });
    }

    getRecord(pluginId: string): PluginRuntimeRecord | undefined {
        return this.records.get(pluginId);
    }

    getRecords(): readonly PluginRuntimeRecord[] {
        return Array.from(this.records.values());
    }

    isActive(pluginId: string): boolean {
        return this.records.get(pluginId)?.state === 'active';
    }

    /**
     * Loads and activates one plugin. Calling this for an already-active plugin
     * is a no-op that returns the existing record.
     */
    async load<TApiResult extends TApi>(request: PluginLoadRequest<TApiResult>): Promise<PluginRuntimeRecord> {
        const { manifest } = request;
        const existing = this.records.get(manifest.id);
        if (existing && (existing.state === 'active' || existing.state === 'loading')) {
            return existing;
        }

        this.records.set(manifest.id, { manifest, state: 'loading' });

        let module: unknown;
        try {
            module = await request.loadModule();
        } catch (error) {
            const record: PluginRuntimeRecord = { manifest, state: 'failed', error };
            this.records.set(manifest.id, record);
            this.onError(manifest, error);
            return record;
        }

        const activate = resolveActivate(module);
        if (!activate) {
            const error = new Error(`Plugin "${manifest.id}" does not export an activate function.`);
            const record: PluginRuntimeRecord = { manifest, state: 'failed', error };
            this.records.set(manifest.id, record);
            this.onError(manifest, error);
            return record;
        }

        const bag = new DisposerBag(error => this.onError(manifest, error));
        const pluginFunction = function iceboxPlugin(ctx: Context): PluginDisposer {
            // Cordis runs this disposer on unload; it must be synchronous to
            // register, and may return a promise so unloading awaits the bag.
            ctx.effect(() => () => bag.disposeAll());
            return () => bag.disposeAll();
        };
        Object.defineProperty(pluginFunction, 'name', { value: `icebox-plugin:${manifest.id}` });

        let fiber: Fiber;
        try {
            fiber = await this.root.plugin(pluginFunction);
        } catch (error) {
            const record: PluginRuntimeRecord = { manifest, state: 'failed', error };
            this.records.set(manifest.id, record);
            this.onError(manifest, error);
            return record;
        }

        this.fibers.set(manifest.id, fiber);

        try {
            const api = request.createApi(this.root, bag);
            const result = await activate.call(api);
            const disposer = toDisposer(result as void | PluginDisposer);
            if (disposer) {
                bag.add(disposer);
            }
            const record: PluginRuntimeRecord = { manifest, state: 'active', fiber };
            this.records.set(manifest.id, record);
            return record;
        } catch (error) {
            const record: PluginRuntimeRecord = { manifest, state: 'failed', error };
            this.records.set(manifest.id, record);
            this.onError(manifest, error);
            await this.unload(manifest.id);
            // Keep the failure visible after unloading the fiber.
            const failed: PluginRuntimeRecord = { manifest, state: 'failed', error };
            this.records.set(manifest.id, failed);
            return failed;
        }
    }

    /** Disposes the plugin's Cordis fiber and everything it registered. */
    async unload(pluginId: string): Promise<void> {
        const fiber = this.fibers.get(pluginId);
        this.fibers.delete(pluginId);
        if (fiber) {
            try {
                await fiber.dispose();
            } catch (error) {
                const manifest = this.records.get(pluginId)?.manifest;
                if (manifest) {
                    this.onError(manifest, error);
                }
            }
        }
        const record = this.records.get(pluginId);
        if (record && record.state !== 'failed') {
            this.records.set(pluginId, { manifest: record.manifest, state: 'idle' });
        }
    }

    /** Unloads every plugin, newest first. */
    async unloadAll(): Promise<void> {
        const ids = Array.from(this.fibers.keys()).reverse();
        for (const id of ids) {
            await this.unload(id);
        }
    }

    /** Disposes the root context, releasing all remaining Cordis resources. */
    async dispose(): Promise<void> {
        await this.unloadAll();
        this.records.clear();
        await this.root.fiber.dispose();
    }
}

interface ActivateExport {
    readonly call: (api: unknown) => unknown;
}

function resolveActivate(module: unknown): ActivateExport | undefined {
    const candidates: unknown[] = [];
    if (typeof module === 'object' && module !== null) {
        const record = module as Record<string, unknown>;
        candidates.push(record.activate);
        const defaultExport = record.default;
        if (typeof defaultExport === 'object' && defaultExport !== null) {
            candidates.push((defaultExport as Record<string, unknown>).activate);
        } else if (typeof defaultExport === 'function') {
            candidates.push(defaultExport);
        }
    }
    for (const candidate of candidates) {
        if (typeof candidate === 'function') {
            return { call: (api: unknown) => (candidate as (value: unknown) => unknown)(api) };
        }
    }
    return undefined;
}
