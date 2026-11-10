import { ContainerModule } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { CommandContribution } from '@theia/core/lib/common/command';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { CanvasApplicationShell } from './canvas-application-shell.js';
import { WorkspacePanelRegistry } from './workspace-panel-registry.js';
import { WorkspaceDockingService } from './workspace-docking-service.js';
import { WorkspaceDemoContribution } from './workspace-demo-contribution.js';
import { PLUGIN_HOST_PATH, PluginHostClient } from '../common/plugin-host-protocol.js';
import { PluginServiceRegistry, PluginEventBus } from './plugin/plugin-kernel.js';
import { PluginManager } from './plugin/plugin-manager.js';
import { PluginManagerWidget } from './plugin/plugin-manager-widget.js';
import { PluginManagerCommands } from './plugin/plugin-manager-commands.js';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    // One visible multiple-document DockPanel replaces the IDE's fixed regions.
    rebind(ApplicationShell).to(CanvasApplicationShell).inSingletonScope();
    bind(WorkspacePanelRegistry).toSelf().inSingletonScope();
    bind(WorkspaceDockingService).toSelf().inSingletonScope();
    bind(WorkspaceDemoContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(WorkspaceDemoContribution);

    // Plugin host: shared registries, the manager, and its UI/commands.
    bind(PluginServiceRegistry).toSelf().inSingletonScope();
    bind(PluginEventBus).toSelf().inSingletonScope();
    bind(PluginManager).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(PluginManager);
    bind(PluginManagerCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(PluginManagerCommands);

    bind(PluginManagerWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: PluginManagerWidget.ID,
        createWidget: () => context.container.get(PluginManagerWidget)
    }));

    // RPC proxy to the backend plugin host service.
    bind(PluginHostClient)
        .toDynamicValue(context =>
            ServiceConnectionProvider.createProxy<PluginHostClient>(
                context.container,
                PLUGIN_HOST_PATH
            )
        )
        .inSingletonScope();
});
