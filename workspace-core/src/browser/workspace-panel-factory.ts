import { inject, injectable } from '@theia/core/shared/inversify';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { Widget } from '@lumino/widgets';
import {
    WORKSPACE_PANEL_FACTORY_ID,
    WorkspacePanelRegistry,
    isWorkspacePanelWidgetOptions,
    type WorkspacePanelWidgetOptions
} from './workspace-panel-registry.js';

/**
 * Placeholder for a saved panel whose plugin is currently disabled, unloading,
 * or uninstalled.
 *
 * Keeping the tab in place is deliberate: the workspace layout belongs to the
 * user, not to the plugin installation. Re-enabling the plugin and restarting
 * restores the real panel, while the placeholder can be closed by hand.
 */
export class WorkspaceUnavailablePanel extends Widget {
    constructor(private readonly options: WorkspacePanelWidgetOptions) {
        super();
        this.id = options.instanceId;
        this.title.label = options.panelTypeId;
        this.title.caption = `Unavailable panel: ${options.panelTypeId}`;
        this.title.closable = true;
        this.addClass('bruce-workspace-unavailable-panel');

        const message = document.createElement('div');
        message.className = 'bruce-workspace-unavailable-message';
        Object.assign(message.style, {
            boxSizing: 'border-box',
            height: '100%',
            padding: '16px',
            color: 'var(--theia-descriptionForeground)',
            fontFamily: 'var(--theia-ui-font-family)'
        });
        message.textContent =
            `No plugin currently provides "${options.panelTypeId}". `
            + 'Enable the plugin that owns this panel to restore it.';
        this.node.append(message);
    }
}

/**
 * The single `WidgetFactory` every workspace panel instance is created under.
 *
 * Routing all panel types through one host factory keeps `WidgetManager` as the
 * sole owner of panel instances, which is what lets Theia persist and rebuild
 * the workspace layout across sessions.
 */
@injectable()
export class WorkspacePanelWidgetFactory implements WidgetFactory {
    readonly id = WORKSPACE_PANEL_FACTORY_ID;

    constructor(@inject(WorkspacePanelRegistry) protected readonly registry: WorkspacePanelRegistry) { }

    async createWidget(options?: unknown): Promise<Widget> {
        if (!isWorkspacePanelWidgetOptions(options)) {
            throw new Error(
                `Panel factory "${WORKSPACE_PANEL_FACTORY_ID}" requires { panelTypeId, instanceId }.`
            );
        }
        return this.registry.instantiate(
            options.instanceId,
            options.panelTypeId,
            parsed => new WorkspaceUnavailablePanel(parsed)
        );
    }
}
