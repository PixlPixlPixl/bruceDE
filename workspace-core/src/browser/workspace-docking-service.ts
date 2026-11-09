import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Widget } from '@lumino/widgets';
import { WorkspacePanelRegistry } from './workspace-panel-registry.js';

export interface WorkspacePanelOpenOptions {
    readonly ref?: Widget;
    readonly mode?: ApplicationShell.WidgetOptions['mode'];
}

/** Opens panels only in the shared main DockPanel, never in fixed IDE areas. */
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
        this.shell.activateWidget(widget.id);
        return widget;
    }
}
