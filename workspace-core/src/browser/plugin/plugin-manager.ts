import { inject, injectable } from '@theia/core/shared/inversify';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { nls } from '@theia/core/lib/common/nls';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import type { PluginManifest } from '@icebox/plugin-api';
import {
    PluginHostClient,
    PluginServiceBridge,
    type PluginDescriptor,
    type PluginHostSnapshot
} from '../../common/plugin-host-protocol.js';
import { WorkspaceDockingService } from '../workspace-docking-service.js';
import { WorkspacePanelRegistry } from '../workspace-panel-registry.js';
import { WorkspaceSelectionService } from '../workspace-selection-service.js';
import { WorkspaceResourceService } from '../workspace-resource-service.js';
import { WorkspaceDialogService } from '../workspace-dialog-service.js';
import { WorkspacePalette } from '../workspace-palette.js';
import { HostPanelFactoryRegistry } from '../host-panels/host-panel-factory-registry.js';
import { PluginEventBus, PluginServiceRegistry } from './plugin-kernel.js';
import { PluginFrontendHost } from './plugin-frontend-host.js';

/** Reconstructs the manifest data the frontend host needs from the wire shape. */
function toManifest(descriptor: PluginDescriptor): PluginManifest {
    return {
        id: descriptor.id,
        name: descriptor.name,
        version: descriptor.version,
        apiVersion: descriptor.apiVersion,
        description: descriptor.description,
        entrypoints: {
            frontend: descriptor.frontendUrl ? 'frontend.js' : undefined,
            backend: descriptor.backendEntrypoint ? 'backend.js' : undefined
        },
        dependencies: Object.fromEntries(descriptor.dependencyIds.map(id => [id, '*'])),
        contributes: {
            panels: descriptor.panels,
            commands: descriptor.commands,
            services: descriptor.services
        }
    };
}

/**
 * Renderer-side plugin manager.
 *
 * It owns the trust decision UI, keeps the authoritative snapshot from the
 * backend, and drives the Cordis-backed frontend host. Enabling a third-party
 * plugin always goes through an explicit full-system-access confirmation; that
 * dialog is disclosure, not a sandbox.
 */
@injectable()
export class PluginManager implements FrontendApplicationContribution {
    protected readonly frontend: PluginFrontendHost;
    protected snapshot: PluginHostSnapshot | undefined;
    protected enabledIds = new Set<string>();
    protected readonly listeners = new Set<(snapshot: PluginHostSnapshot) => void>();
    protected hostServiceDisposers: (() => void | Promise<void>)[] = [];

    constructor(
        @inject(PluginHostClient) protected readonly backend: PluginHostClient,
        @inject(WorkspacePanelRegistry) protected readonly panels: WorkspacePanelRegistry,
        @inject(WorkspaceDockingService) protected readonly docking: WorkspaceDockingService,
        @inject(PluginServiceRegistry) protected readonly services: PluginServiceRegistry,
        @inject(PluginEventBus) protected readonly events: PluginEventBus,
        @inject(WorkspaceSelectionService) protected readonly selection: WorkspaceSelectionService,
        @inject(WorkspaceResourceService) protected readonly resources: WorkspaceResourceService,
        @inject(WorkspaceDialogService) protected readonly dialogs: WorkspaceDialogService,
        @inject(WorkspacePalette) protected readonly palette: WorkspacePalette,
        @inject(HostPanelFactoryRegistry) protected readonly hostPanels: HostPanelFactoryRegistry,
        @inject(CommandRegistry) protected readonly commands: CommandRegistry,
        @inject(MessageService) protected readonly messages: MessageService,
        @inject(PluginServiceBridge) protected readonly serviceBridge: PluginServiceBridge
    ) {
        this.frontend = new PluginFrontendHost({
            panelRegistry: this.panels,
            docking: this.docking,
            commands: this.commands,
            services: this.services,
            events: this.events,
            hostPanelFactories: this.hostPanels,
            palette: this.palette,
            readBundleSource: (pluginId, frontendUrl) => this.readBundleSource(pluginId, frontendUrl),
            invokeRemote: (serviceId, method, args) => this.serviceBridge.invoke(serviceId, method, args),
            onError: (pluginId, error) => {
                void this.backend.reportError(pluginId, error instanceof Error ? error.message : String(error));
            }
        });
    }

    async onStart(_app: FrontendApplication): Promise<void> {
        await this.frontend.initialize();
        // Host services are published *before* any plugin activates, so a plugin
        // can consume `workspace.resources`/`workspace.selection` during its own
        // `activate` instead of racing the host's startup.
        this.installHostServices();
        await this.refresh();
        await this.activateEnabledPlugins();
    }

    /** Publishes the host's own services under `icebox.workspace`. Idempotent. */
    protected installHostServices(): void {
        if (this.hostServiceDisposers.length > 0) {
            return;
        }
        this.hostServiceDisposers = [
            this.resources.install(),
            this.selection.install(),
            this.dialogs.install()
        ];
    }

    onStop(): void {
        void this.frontend.unloadAll().finally(() => this.frontend.dispose());
        for (const dispose of this.hostServiceDisposers.splice(0)) {
            try {
                void dispose();
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('[plugin-host] Failed to release host services:', error);
            }
        }
    }

    getSnapshot(): PluginHostSnapshot | undefined {
        return this.snapshot;
    }

    onDidChangeSnapshot(listener: (snapshot: PluginHostSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async refresh(): Promise<PluginHostSnapshot> {
        this.snapshot = await this.backend.refresh();
        this.enabledIds = new Set(this.snapshot.enabled);
        this.emit();
        return this.snapshot;
    }

    /**
     * Enables or disables a plugin. Enabling third-party code requires an
     * explicit acceptance of the full-system-access warning first.
     */
    async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
        const descriptor = this.requireDescriptor(pluginId);
        if (enabled && !this.isTrusted(pluginId)) {
            const accepted = await this.confirmFullSystemAccess(descriptor);
            if (!accepted) {
                return;
            }
            this.snapshot = await this.backend.setTrusted(pluginId, true);
        }

        this.snapshot = await this.backend.setEnabled(pluginId, enabled);
        if (enabled) {
            await this.activate(descriptor);
        } else {
            await this.frontend.unload(pluginId);
        }
        this.enabledIds = new Set(this.snapshot.enabled);
        this.emit();
    }

    /**
     * Loads a plugin's bundle text.
     *
     * An Electron renderer runs from a `file://` origin, so an HTTP URL on the
     * backend is cross-origin and the asset route sends no CORS headers: `fetch`
     * fails no matter how the URL is built. The bundle therefore travels over the
     * existing RPC channel there. The browser target is same-origin and uses the
     * served URL, keeping the payload off the RPC socket.
     */
    protected async readBundleSource(pluginId: string, frontendUrl: string): Promise<string> {
        const sameOrigin = typeof location !== 'undefined'
            && (location.protocol === 'http:' || location.protocol === 'https:');
        if (sameOrigin) {
            const response = await fetch(frontendUrl, { cache: 'no-cache' });
            if (!response.ok) {
                throw new Error(`Failed to load plugin bundle ${frontendUrl}: HTTP ${response.status}`);
            }
            return response.text();
        }
        return this.backend.readFrontendBundle(pluginId);
    }

    isEnabled(pluginId: string): boolean {
        return this.enabledIds.has(pluginId);
    }

    isTrusted(pluginId: string): boolean {
        return this.snapshot?.trusted.includes(pluginId) ?? false;
    }

    protected async activateEnabledPlugins(): Promise<void> {
        if (!this.snapshot) {
            return;
        }
        for (const pluginId of this.snapshot.enabled) {
            const descriptor = this.snapshot.plugins.find(candidate => candidate.id === pluginId);
            if (!descriptor) {
                continue;
            }
            try {
                await this.activate(descriptor);
            } catch (error) {
                // One broken plugin must never stop the remaining ones.
                // eslint-disable-next-line no-console
                console.error(`[plugin-host] Frontend plugin "${pluginId}" threw during activation:`, error);
            }
        }
    }

    protected async activate(descriptor: PluginDescriptor): Promise<void> {
        const record = await this.frontend.load(descriptor, toManifest(descriptor));
        if (record?.state === 'failed') {
            // Not awaited: the dialog stays until the user dismisses it, and the
            // remaining plugins must not wait for that.
            void this.messages.error(
                nls.localize('icebox/pluginRuntime', 'Plugin "{0}" failed to activate.', descriptor.id)
            );
        }
    }

    protected requireDescriptor(pluginId: string): PluginDescriptor {
        const descriptor = this.snapshot?.plugins.find(plugin => plugin.id === pluginId);
        if (!descriptor) {
            throw new Error(`Unknown plugin: ${pluginId}`);
        }
        return descriptor;
    }

    protected emit(): void {
        const snapshot = this.snapshot;
        if (snapshot) {
            for (const listener of this.listeners) {
                listener(snapshot);
            }
        }
    }

    /** Full-system-access disclosure. Required before third-party plugins run. */
    protected async confirmFullSystemAccess(descriptor: PluginDescriptor): Promise<boolean> {
        const dialog = new ConfirmDialog({
            title: nls.localize('icebox/pluginRuntime', 'Enable third-party plugin?'),
            msg: nls.localize(
                'icebox/pluginRuntime',
                '"{0}" is third-party code. Icebox plugins run with the full privileges of this application: they can read and write files, run processes, and use the network. There is no sandbox. Only enable plugins you trust.',
                `${descriptor.name} (${descriptor.id})`
            ),
            ok: nls.localize('icebox/pluginRuntime', 'I understand, enable it'),
            cancel: nls.localize('icebox/pluginRuntime', 'Cancel')
        });
        try {
            return (await dialog.open()) === true;
        } catch {
            return false;
        }
    }
}
