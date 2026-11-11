import { CordisPluginManager, type PluginRuntimeRecord } from '@icebox/plugin-runtime';
import type { FrontendPluginAPI, PluginManifest } from '@icebox/plugin-api';
import type { PluginDescriptor } from '../../common/plugin-host-protocol.js';
import type { DisposerBag } from '@icebox/plugin-runtime';
import { WorkspaceDockingService } from '../workspace-docking-service.js';
import { HostModuleRegistry, rewriteHostModuleSpecifiers } from './host-modules.js';
import { PluginKernel, type PluginKernelOptions } from './plugin-kernel.js';

export interface PluginFrontendHostOptions extends PluginKernelOptions {
    readonly docking: WorkspaceDockingService;
    readonly onError?: (pluginId: string, error: unknown) => void;
    /**
     * Returns the plugin's frontend bundle text. The renderer cannot decide this
     * on its own: an Electron renderer runs from a `file://` origin and has to go
     * through the backend RPC, while the browser target can fetch the served URL.
     */
    readonly readBundleSource: (pluginId: string, frontendUrl: string) => Promise<string>;
}

/**
 * Loads frontend plugin bundles into the renderer and activates them inside
 * Cordis fibers.
 *
 * The runtime contract every plugin uses:
 * 1. the bundle is a normal ESM module served by the backend;
 * 2. shared host modules (`react`, `@lumino/widgets`, …) resolve to the host's
 *    own instances through rewrite-to-blob shims;
 * 3. `activate(api)` registers panels/commands/services/events;
 * 4. disposing the Cordis fiber unregisters everything and closes owned panels.
 */
export class PluginFrontendHost {
    private readonly kernel: PluginKernel;
    private readonly manager: CordisPluginManager<FrontendPluginAPI>;
    private readonly hostModules = new HostModuleRegistry();
    private readonly loadedIds = new Set<string>();
    private readonly pluginDirectories = new Map<string, string>();

    constructor(private readonly options: PluginFrontendHostOptions) {
        this.kernel = new PluginKernel(options);
        this.manager = new CordisPluginManager<FrontendPluginAPI>({
            onError: (manifest, error) => {
                this.options.onError?.(manifest.id, error);
                // eslint-disable-next-line no-console
                console.error(`[plugin-host] Frontend plugin "${manifest.id}" failed:`, error);
            }
        });
    }

    async initialize(): Promise<void> {
        await this.hostModules.initialize();
    }

    isActive(pluginId: string): boolean {
        return this.manager.isActive(pluginId);
    }

    getRecord(pluginId: string): PluginRuntimeRecord | undefined {
        return this.manager.getRecord(pluginId);
    }

    /**
     * Loads a plugin's frontend bundle and activates it. Silently succeeds for
     * plugins without a frontend entrypoint.
     */
    async load(descriptor: PluginDescriptor, manifest: PluginManifest): Promise<PluginRuntimeRecord | undefined> {
        if (!descriptor.frontendUrl) {
            return undefined;
        }
        if (this.loadedIds.has(manifest.id)) {
            return this.manager.getRecord(manifest.id);
        }
        this.pluginDirectories.set(manifest.id, descriptor.directory);

        const record = await this.manager.load<FrontendPluginAPI>({
            manifest,
            loadModule: async () => {
                const source = await this.fetchBundle(manifest.id, descriptor.frontendUrl!);
                const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                try {
                    return await import(/* @vite-ignore */ url);
                } finally {
                    URL.revokeObjectURL(url);
                }
            },
            createApi: (_ctx, bag: DisposerBag) =>
                this.kernel.createApi(manifest, descriptor.directory, bag)
        });

        if (record.state === 'active') {
            this.loadedIds.add(manifest.id);
        }
        return record;
    }

    async unload(pluginId: string): Promise<void> {
        // Close owned panels before the fiber drops the registrations that
        // describe them, so the shell can still resolve each widget. Panels
        // created through a host capability are host-owned and stay open.
        await this.options.docking.closePanelsByOwner(pluginId);
        this.kernel.releaseOwner(pluginId);
        await this.manager.unload(pluginId);
        this.loadedIds.delete(pluginId);
    }

    async unloadAll(): Promise<void> {
        for (const pluginId of Array.from(this.loadedIds)) {
            await this.unload(pluginId);
        }
    }

    dispose(): void {
        this.hostModules.dispose();
    }

    private async fetchBundle(pluginId: string, url: string): Promise<string> {
        const source = await this.options.readBundleSource(pluginId, url);
        return rewriteHostModuleSpecifiers(source, this.hostModules.getRewriteMap());
    }
}
