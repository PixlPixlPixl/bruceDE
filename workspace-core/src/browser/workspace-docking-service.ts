import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Widget } from '@lumino/widgets';
import { WorkspacePanelRegistry, WorkspacePanelState } from './workspace-panel-registry.js';

export interface WorkspacePanelOpenOptions {
    readonly ref?: Widget;
    readonly mode?: ApplicationShell.WidgetOptions['mode'];
    /** Instance state handed to the panel definition and saved with the layout. */
    readonly state?: WorkspacePanelState;
}

/**
 * Opens panels only in the shared main DockPanel, never in fixed IDE areas.
 *
 * Panels are created through {@link WorkspacePanelRegistry}, which goes through
 * the host's `WidgetManager`. Instance bookkeeping therefore lives in the
 * registry too, so panels re-created from a persisted layout are tracked exactly
 * like panels the user opened in this session.
 */
@injectable()
export class WorkspaceDockingService {
    constructor(
        @inject(ApplicationShell) protected readonly shell: ApplicationShell,
        @inject(WorkspacePanelRegistry) protected readonly registry: WorkspacePanelRegistry
    ) { }

    async openPanel(
        panelTypeId: string,
        options: WorkspacePanelOpenOptions = {}
    ): Promise<Widget> {
        const widget = await this.registry.createPanel(panelTypeId, { state: options.state });
        await this.shell.addWidget(widget, {
            area: 'main',
            ref: options.ref,
            mode: options.mode
        });
        await this.shell.activateWidget(widget.id);
        return widget;
    }

    /** Resolves an open panel instance id to its widget. */
    getWidgetById(instanceId: string): Widget | undefined {
        return this.shell.getWidgetById(instanceId);
    }

    /**
     * Brings an open panel instance to the front.
     *
     * Used by a plugin that added content to a panel it did not open: the panel
     * is where the new content lives, so the shell has to show it.
     */
    async activatePanel(instanceId: string): Promise<void> {
        if (!this.shell.getWidgetById(instanceId)) {
            return;
        }
        await this.shell.activateWidget(instanceId);
    }

    /** Instance ids of a panel type that are currently open. */
    getOpenInstances(panelTypeId: string): readonly string[] {
        return this.registry.getOpenInstances(panelTypeId);
    }

    /**
     * Instance ids of panel types a plugin registered, host panels included.
     * For the closable subset see {@link closePanelsByOwner}.
     */
    getOpenInstancesByOwner(owner: string): readonly string[] {
        return this.registry.getOpenInstancesByOwner(owner);
    }

    async closePanel(instanceId: string): Promise<void> {
        const widget = this.shell.getWidgetById(instanceId);
        if (!widget) {
            this.registry.forgetInstance(instanceId);
            return;
        }
        await this.shell.closeWidget(instanceId);
        this.registry.forgetInstance(instanceId);
    }

    /**
     * Closes every panel instance the plugin itself owns.
     *
     * Called by the plugin runtime during disposal so a disabled plugin can never
     * leave orphan plugin widgets. Host-capability panels are intentionally left
     * open: they were created by host code, the host restores them, and they are
     * user state the host has taken responsibility for. Unloading the plugin
     * withdraws its panel *type* and commands, not the terminal the user is in.
     */
    async closePanelsByOwner(owner: string): Promise<void> {
        for (const instanceId of this.registry.getPluginOwnedInstancesByOwner(owner)) {
            try {
                await this.closePanel(instanceId);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('[workspace] Failed to close panel "%s":', instanceId, error);
            }
        }
    }
}
