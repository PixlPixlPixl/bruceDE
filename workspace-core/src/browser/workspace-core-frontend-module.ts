import { ContainerModule } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { CommandContribution } from '@theia/core/lib/common';
import { CanvasApplicationShell } from './canvas-application-shell.js';
import { WorkspacePanelRegistry } from './workspace-panel-registry.js';
import { WorkspaceDockingService } from './workspace-docking-service.js';
import { WorkspaceDemoContribution } from './workspace-demo-contribution.js';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    // One visible multiple-document DockPanel replaces the IDE's fixed regions.
    rebind(ApplicationShell).to(CanvasApplicationShell).inSingletonScope();
    bind(WorkspacePanelRegistry).toSelf().inSingletonScope();
    bind(WorkspaceDockingService).toSelf().inSingletonScope();
    bind(WorkspaceDemoContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(WorkspaceDemoContribution);
});
