import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { injectable, inject } from '@theia/core/shared/inversify';
import { WorkspaceDockingService } from './workspace-docking-service.js';
import { WorkspacePanelRegistry } from './workspace-panel-registry.js';
import { WorkspaceDemoWidget } from './workspace-demo-widget.js';

const OPEN_DEMO_LAYOUT: Command = {
    id: 'bruce.workspace.openDockingDemo',
    label: 'Workspace: Open docking demo layout'
};
const OPEN_DEMO_TERMINAL: Command = {
    id: 'bruce.workspace.openDemoTerminal',
    label: 'Workspace: Open demo terminal panel'
};
const OPEN_DEMO_AGENT: Command = {
    id: 'bruce.workspace.openDemoAgent',
    label: 'Workspace: Open demo agent panel'
};
const OPEN_DEMO_GIT: Command = {
    id: 'bruce.workspace.openDemoGit',
    label: 'Workspace: Open demo Git panel'
};

@injectable()
export class WorkspaceDemoContribution implements CommandContribution {
    constructor(
        @inject(WorkspacePanelRegistry) protected readonly panels: WorkspacePanelRegistry,
        @inject(WorkspaceDockingService) protected readonly docking: WorkspaceDockingService
    ) {
        // Register panel types only. The initial workspace remains empty.
        this.panels.registerPanel({
            id: 'bruce.demo.terminal',
            title: 'Demo Terminal',
            createWidget: id => new WorkspaceDemoWidget(
                id, 'Terminal panel placeholder',
                'The real terminal extension will render its terminal widget here.',
                '$ pwd\n/home/user/project\n\n$ pi\nAgent CLI would run here.'
            )
        });
        this.panels.registerPanel({
            id: 'bruce.demo.agent',
            title: 'Demo Agent',
            createWidget: id => new WorkspaceDemoWidget(
                id, 'Agent panel placeholder',
                'An independent extension panel that can be split or tabbed with any other panel.',
                'Agent: Ready\nSession: demo\n\nNo agent process is started by this docking test.'
            )
        });
        this.panels.registerPanel({
            id: 'bruce.demo.git',
            title: 'Demo Git',
            createWidget: id => new WorkspaceDemoWidget(
                id, 'Git panel placeholder',
                'A third panel to verify nested splits and tab docking.',
                'Changes\n  M  package.json\n  M  src/workspace.ts\n\nBranches\n  main'
            )
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(OPEN_DEMO_LAYOUT, { execute: () => this.openDemoLayout() });
        commands.registerCommand(OPEN_DEMO_TERMINAL, {
            execute: () => this.docking.openPanel('bruce.demo.terminal')
        });
        commands.registerCommand(OPEN_DEMO_AGENT, {
            execute: () => this.docking.openPanel('bruce.demo.agent')
        });
        commands.registerCommand(OPEN_DEMO_GIT, {
            execute: () => this.docking.openPanel('bruce.demo.git')
        });
    }

    protected async openDemoLayout(): Promise<void> {
        const terminal = await this.docking.openPanel('bruce.demo.terminal');
        await this.docking.openPanel('bruce.demo.agent', { ref: terminal, mode: 'split-right' });
        await this.docking.openPanel('bruce.demo.git', { ref: terminal, mode: 'split-bottom' });
    }
}
