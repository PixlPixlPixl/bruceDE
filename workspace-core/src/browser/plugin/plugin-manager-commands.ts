import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { nls } from '@theia/core/lib/common/nls';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import type { PluginHostSnapshot } from '../../common/plugin-host-protocol.js';
import { PluginManager } from './plugin-manager.js';
import { PluginManagerWidget } from './plugin-manager-widget.js';

const OPEN_PLUGIN_MANAGER: Command = {
    id: 'icebox.plugins.openManager',
    label: nls.localize('icebox/pluginManager', 'Plugins: Open Plugin Manager')
};

const ENABLE_PLUGIN_PREFIX = 'icebox.plugins.enable.';
const DISABLE_PLUGIN_PREFIX = 'icebox.plugins.disable.';

/**
 * Registers the plugin manager command plus one enable/disable command per
 * discovered plugin, so plugins can be toggled from the command palette before
 * the manager widget is opened.
 */
@injectable()
export class PluginManagerCommands implements CommandContribution {
    protected commandRegistry: CommandRegistry | undefined;
    protected readonly registered = new Set<string>();

    constructor(
        @inject(PluginManager) protected readonly manager: PluginManager,
        @inject(WidgetManager) protected readonly widgets: WidgetManager,
        @inject(ApplicationShell) protected readonly shell: ApplicationShell
    ) { }

    registerCommands(commands: CommandRegistry): void {
        this.commandRegistry = commands;
        commands.registerCommand(OPEN_PLUGIN_MANAGER, {
            execute: () => this.openManager()
        });
        const snapshot = this.manager.getSnapshot();
        if (snapshot) {
            this.registerPluginCommands(snapshot);
        }
        // Keep listening: plugins discovered on a later refresh must also get
        // their enable/disable commands. Registration is idempotent.
        this.manager.onDidChangeSnapshot(latest => this.registerPluginCommands(latest));
    }

    protected registerPluginCommands(snapshot: PluginHostSnapshot): void {
        const commands = this.commandRegistry;
        if (!commands) {
            return;
        }
        for (const plugin of snapshot.plugins) {
            const enableId = `${ENABLE_PLUGIN_PREFIX}${plugin.id}`;
            const disableId = `${DISABLE_PLUGIN_PREFIX}${plugin.id}`;
            if (!this.registered.has(enableId)) {
                this.registered.add(enableId);
                commands.registerCommand(
                    { id: enableId, label: nls.localize('icebox/pluginManager', 'Plugins: Enable {0}', plugin.name) },
                    { execute: () => this.manager.setEnabled(plugin.id, true) }
                );
            }
            if (!this.registered.has(disableId)) {
                this.registered.add(disableId);
                commands.registerCommand(
                    {
                        id: disableId,
                        label: nls.localize('icebox/pluginManager', 'Plugins: Disable {0}', plugin.name)
                    },
                    { execute: () => this.manager.setEnabled(plugin.id, false) }
                );
            }
        }
    }

    protected async openManager(): Promise<void> {
        const widget = await this.widgets.getOrCreateWidget(PluginManagerWidget.ID);
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(PluginManagerWidget.ID);
    }
}
