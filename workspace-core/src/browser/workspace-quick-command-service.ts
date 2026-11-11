import { inject, injectable } from '@theia/core/shared/inversify';
import { Command } from '@theia/core/lib/common/command';
import { QuickCommandService } from '@theia/core/lib/browser/quick-input/quick-command-service';
import { WorkspacePalette } from './workspace-palette.js';

/**
 * The F1 palette, restricted to the workspace menu.
 *
 * Filtering happens at the one point every palette entry goes through, so the
 * result is a short, deliberate list with no hidden commands, no recently-used
 * commands from elsewhere and no duplicates of what a panel already shows. The
 * restriction is presentation only: every command stays registered, so key
 * bindings and other UI keep working exactly as before.
 */
@injectable()
export class WorkspaceQuickCommandService extends QuickCommandService {
    @inject(WorkspacePalette)
    protected readonly palette!: WorkspacePalette;

    protected override getValidCommands(raw: Command[]): Command[] {
        return super.getValidCommands(raw.filter(command => this.palette.shows(command.id)));
    }
}
