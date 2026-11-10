import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Widget } from '@lumino/widgets';
import { WorkspacePanelRegistry } from './workspace-panel-registry.js';

export interface WorkspacePanelOpenOptions {
    readonly ref?: Widget;
    readonly mode?: ApplicationShell.WidgetOptions['mode'];
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
        const widget = await this.registry.createPanel(panelTypeId);
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

    /** Instance ids of a panel type that are currently open. */
    getOpenInstances(panelTypeId: string): readonly string[] {
        return this.registry.getOpenInstances(panelTypeId);
    }

    /** Instance ids owned by a plugin, across all of its panel types. */
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
     * Closes every panel instance a plugin opened. Called by the plugin runtime
     * during disposal so a disabled plugin can never leave orphan widgets.
     */
    async closePanelsByOwner(owner: string): Promise<void> {
        for (const instanceId of this.getOpenInstancesByOwner(owner)) {
            try {
                await this.closePanel(instanceId);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[workspace] Failed to close panel "${instanceId}":`, error);
            }
        }
    }
}
