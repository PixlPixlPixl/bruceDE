import { injectable } from '@theia/core/shared/inversify';
import type { WidgetOpenerOptions } from '@theia/core/lib/browser';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { TerminalShellHandler } from '@theia/terminal/lib/browser/terminal-shell-handler';
import type { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';

/**
 * Keeps the canvas empty on a first start.
 *
 * The stock contribution opens a terminal into `area: 'bottom'` when there is no
 * stored layout. `CanvasApplicationShell` deliberately has no bottom panel, so
 * that terminal would be created and never shown. BruceDE's rule is that the
 * startup canvas is empty until the user acts, so this is a no-op.
 */
@injectable()
export class CanvasTerminalFrontendContribution extends TerminalFrontendContribution {
    override async initializeLayout(): Promise<void> {
        return;
    }
}

/**
 * Routes every terminal into the shared main DockPanel.
 *
 * `TerminalShellHandler` is the default `TerminalCreationHandler` and sends
 * panel terminals to `area: 'bottom'`, which the canvas does not have. Forcing
 * the area here — *after* the parent's own view-column/ref/mode decisions — fixes
 * placement for every path at once: the built-in `Terminal: New Terminal`
 * command, `Terminal: New Terminal in Current Workspace`, terminal splits and
 * terminals restored from a saved layout.
 */
@injectable()
export class CanvasTerminalShellHandler extends TerminalShellHandler {
    override async onWillOpenTerminal(
        terminal: TerminalWidget,
        options?: WidgetOpenerOptions
    ): Promise<boolean> {
        return super.onWillOpenTerminal(terminal, {
            ...options,
            // Last wins: the parent computes `{ area, ...widgetOptions }`, so
            // `main` survives even when a caller asked for another region.
            widgetOptions: { ...options?.widgetOptions, area: 'main' }
        });
    }
}
