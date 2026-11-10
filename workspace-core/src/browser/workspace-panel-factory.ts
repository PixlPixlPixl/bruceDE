import { inject, injectable } from '@theia/core/shared/inversify';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { Widget } from '@lumino/widgets';
import {
    WORKSPACE_PANEL_FACTORY_ID,
    WorkspacePanelRegistry,
    isWorkspacePanelWidgetOptions
} from './workspace-panel-registry.js';
import { WorkspaceUnavailablePanel } from './workspace-unavailable-panel.js';

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
            parsed => new WorkspaceUnavailablePanel(parsed),
            options.state
        );
    }
}
