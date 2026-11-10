import { Widget } from '@lumino/widgets';
import type { WorkspacePanelWidgetOptions } from './workspace-panel-registry.js';

/**
 * Placeholder for a panel whose backing panel type is not currently registered:
 * the owning plugin is disabled, unloading, or no longer installed.
 *
 * Keeping the tab in place is deliberate. The workspace layout belongs to the
 * user, not to the plugin installation, so one missing plugin must not drop the
 * whole restored layout. Re-enabling the plugin and restarting brings the real
 * panel back; the placeholder can also be closed by hand.
 */
export class WorkspaceUnavailablePanel extends Widget {
    constructor(options: WorkspacePanelWidgetOptions) {
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
