import { ContainerModule } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { CommandContribution } from '@theia/core/lib/common/command';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { bindContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { CanvasApplicationShell } from './canvas-application-shell.js';
import {
    CanvasTerminalFrontendContribution,
    CanvasTerminalShellHandler
} from './canvas-terminal.js';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { TerminalShellHandler } from '@theia/terminal/lib/browser/terminal-shell-handler';
import {
    HostPanelFactory,
    HostPanelFactoryRegistry
} from './host-panels/host-panel-factory-registry.js';
import { TerminalHostPanelFactory } from './host-panels/terminal-panel-factory.js';
import { WorkspacePanelRegistry } from './workspace-panel-registry.js';
import { WorkspacePanelWidgetFactory } from './workspace-panel-factory.js';
import { WorkspaceDockingService } from './workspace-docking-service.js';
import { WorkspaceSelectionService } from './workspace-selection-service.js';
import { WorkspaceResourceService } from './workspace-resource-service.js';
import {
    PLUGIN_HOST_PATH,
    PLUGIN_SERVICE_RPC_PATH,
    PluginHostClient,
    PluginServiceBridge
} from '../common/plugin-host-protocol.js';
import { PluginServiceRegistry, PluginEventBus } from './plugin/plugin-kernel.js';
import { PluginManager } from './plugin/plugin-manager.js';
import { PluginManagerWidget } from './plugin/plugin-manager-widget.js';
import { PluginManagerCommands } from './plugin/plugin-manager-commands.js';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    // One visible multiple-document DockPanel replaces the IDE's fixed regions.
    rebind(ApplicationShell).to(CanvasApplicationShell).inSingletonScope();
    // The canvas has no bottom panel, so the stock terminal contribution would
    // create terminals that are never shown. Both overrides route terminals into
    // the shared main DockPanel and keep the startup canvas empty.
    rebind(TerminalFrontendContribution)
        .to(CanvasTerminalFrontendContribution)
        .inSingletonScope();
    rebind(TerminalShellHandler).to(CanvasTerminalShellHandler).inSingletonScope();

    bind(HostPanelFactoryRegistry).toSelf().inSingletonScope();
    bindContributionProvider(bind, HostPanelFactory);
    bind(TerminalHostPanelFactory).toSelf().inSingletonScope();
    bind(HostPanelFactory).toService(TerminalHostPanelFactory);

    bind(WorkspacePanelRegistry).toSelf().inSingletonScope();
    // Every panel instance is created through this one host factory, so
    // WidgetManager owns it and Theia's layout restorer can rebuild it.
    bind(WorkspacePanelWidgetFactory).toSelf().inSingletonScope();
    bind(WidgetFactory).toService(WorkspacePanelWidgetFactory);
    bind(WorkspaceDockingService).toSelf().inSingletonScope();
    bind(WorkspaceSelectionService).toSelf().inSingletonScope();
    bind(WorkspaceResourceService).toSelf().inSingletonScope();

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

    // RPC proxies to the backend plugin host and the service bridge.
    bind(PluginServiceBridge)
        .toDynamicValue(context =>
            ServiceConnectionProvider.createProxy<PluginServiceBridge>(
                context.container,
                PLUGIN_SERVICE_RPC_PATH
            )
        )
        .inSingletonScope();
    bind(PluginHostClient)
        .toDynamicValue(context =>
            ServiceConnectionProvider.createProxy<PluginHostClient>(
                context.container,
                PLUGIN_HOST_PATH
            )
        )
        .inSingletonScope();
});
