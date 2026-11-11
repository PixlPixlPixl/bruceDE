import {
    HOST_PANEL_CAPABILITIES,
    type FrontendPluginAPI,
    type PluginDisposer
} from '@icebox/plugin-api';

const COMMAND_NEW = 'icebox.terminal.open';
const PANEL_TERMINAL = 'terminal.main';

/**
 * Native renderer entrypoint for the terminal.
 *
 * The plugin does not build a terminal widget and never imports Theia internals:
 * it adopts the host's `icebox.terminal` capability, so the host's own terminal
 * code creates, renders, persists and disposes the widget. The built-in
 * `Terminal: New Terminal` command goes through exactly the same host code path.
 */
export function activate(api: FrontendPluginAPI): PluginDisposer {
    const capability = HOST_PANEL_CAPABILITIES.terminal;
    if (!api.panels.hasHostCapability(capability)) {
        // Fail loudly instead of registering a panel nothing can satisfy.
        throw new Error(
            `This Icebox build does not expose the "${capability}" host capability, so icebox.terminal cannot load.`
        );
    }

    const unregisterPanel = api.panels.registerHostPanel({
        id: PANEL_TERMINAL,
        title: 'Terminal',
        capabilityId: capability
    });

    api.commands.register({
        id: COMMAND_NEW,
        title: 'Terminal: New Terminal',
        execute: () => api.panels.open(PANEL_TERMINAL)
    });

    return unregisterPanel;
}
