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
 * It also owns instance bookkeeping: every opened widget is traced back to the
 * panel type and therefore to the plugin that registered it. When a plugin
 * unloads, {@link closePanelsByOwner} closes exactly the instances it opened.
 */
@injectable()
export class WorkspaceDockingService {
    /** Open widget id → panel type id. */
    protected readonly openInstances = new Map<string, string>();

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
        this.openInstances.set(widget.id, panelTypeId);
        widget.disposed.connect(() => {
            this.openInstances.delete(widget.id);
        });
        this.shell.activateWidget(widget.id);
        return widget;
    }

    /** Resolves an open panel instance id to its widget. */
    getWidgetById(instanceId: string): Widget | undefined {
        return this.shell.getWidgetById(instanceId);
    }

    /** Instance ids of a panel type that are currently open. */
    getOpenInstances(panelTypeId: string): readonly string[] {
        return Array.from(this.openInstances.entries())
            .filter(([, typeId]) => typeId === panelTypeId)
            .map(([instanceId]) => instanceId);
    }

    /** Instance ids owned by a plugin, across all of its panel types. */
    getOpenInstancesByOwner(owner: string): readonly string[] {
        const ownedTypes = new Set(this.registry.getPanelTypesByOwner(owner));
        return Array.from(this.openInstances.entries())
            .filter(([, typeId]) => ownedTypes.has(typeId))
            .map(([instanceId]) => instanceId);
    }

    async closePanel(instanceId: string): Promise<void> {
        const widget = this.shell.getWidgetById(instanceId);
        if (!widget) {
            this.openInstances.delete(instanceId);
            return;
        }
        await this.shell.closeWidget(instanceId);
        this.openInstances.delete(instanceId);
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
