import { inject, injectable } from '@theia/core/shared/inversify';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import type { Widget } from '@lumino/widgets';
import { HOST_PANEL_CAPABILITIES } from '@icebox/plugin-api';
import type { HostPanelCreateRequest, HostPanelFactory } from './host-panel-factory-registry.js';

/**
 * The `icebox.terminal` capability: a real Theia terminal, created host-side.
 *
 * It deliberately reuses `TerminalFrontendContribution.newTerminal()` — the
 * exact call the host's own `Terminal: New Terminal` command reaches through
 * `ShellTerminalProfile.start()`. That keeps one creation path for both, so a
 * plugin terminal and a built-in terminal are the same object graph, and Theia
 * keeps owning process lifecycle, xterm rendering and restore behaviour.
 *
 * The factory returns the terminal widget itself (not a wrapper): a workspace
 * panel around it would break `TerminalService.getById`, terminal splits and
 * Theia's own terminal restore.
 */
@injectable()
export class TerminalHostPanelFactory implements HostPanelFactory {
    readonly capabilityId = HOST_PANEL_CAPABILITIES.terminal;
    readonly label = 'Terminal';

    constructor(
        @inject(TerminalFrontendContribution) protected readonly terminals: TerminalFrontendContribution
    ) { }

    async createPanel(request: HostPanelCreateRequest): Promise<Widget> {
        const widget = await this.terminals.newTerminal(request.options as Parameters<
            TerminalFrontendContribution['newTerminal']
        >[0] ?? {});
        // `ShellTerminalProfile.start()` starts the terminal process right after
        // creation; mirroring that keeps behaviour identical between the built-in
        // command and this capability. `start()` refuses to run twice.
        void widget.start().catch(error => {
            // eslint-disable-next-line no-console
            console.error(`[workspace] Terminal "${request.instanceId}" failed to start:`, error);
        });
        if (!widget.title.label) {
            widget.title.label = `Terminal ${request.instanceId}`;
        }
        widget.title.closable = true;
        return widget;
    }
}
