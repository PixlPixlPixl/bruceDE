import { injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Layout } from '@lumino/widgets';

/**
 * A shell whose only visible workbench region is Theia's main DockPanel.
 * The standard side/bottom managers are deliberately omitted from the
 * root layout. Workspace extensions must add widgets to the main area.
 */
@injectable()
export class CanvasApplicationShell extends ApplicationShell {
    protected override createLayout(): Layout {
        return this.createBoxLayout(
            [this.mainPanel],
            [1],
            { direction: 'top-to-bottom', spacing: 0 }
        );
    }
}
