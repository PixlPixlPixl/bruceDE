import { injectable } from '@theia/core/shared/inversify';
import { Widget } from '@lumino/widgets';

/**
 * Describes an available panel type. It deliberately has no placement.
 */
export interface WorkspacePanelDefinition {
    readonly id: string;
    readonly title: string;
    readonly createWidget: (instanceId: string) => Widget | Promise<Widget>;
}

@injectable()
export class WorkspacePanelRegistry {
    protected readonly definitions = new Map<string, WorkspacePanelDefinition>();
    protected readonly instanceCounters = new Map<string, number>();

    registerPanel(definition: WorkspacePanelDefinition): () => void {
        if (!definition.id.trim()) {
            throw new Error('A workspace panel definition must have a non-empty id.');
        }
        if (this.definitions.has(definition.id)) {
            throw new Error('Workspace panel already registered: ' + definition.id);
        }
        this.definitions.set(definition.id, definition);
        return () => {
            if (this.definitions.get(definition.id) === definition) {
                this.definitions.delete(definition.id);
            }
        };
    }

    getPanelDefinitions(): readonly WorkspacePanelDefinition[] {
        return Array.from(this.definitions.values());
    }

    async createPanel(panelTypeId: string): Promise<Widget> {
        const definition = this.definitions.get(panelTypeId);
        if (!definition) {
            throw new Error('Unknown workspace panel type: ' + panelTypeId);
        }
        const next = (this.instanceCounters.get(panelTypeId) ?? 0) + 1;
        this.instanceCounters.set(panelTypeId, next);
        const instanceId = panelTypeId + '.' + next;
        const widget = await definition.createWidget(instanceId);
        if (!widget.id) { widget.id = instanceId; }
        if (!widget.title.label) { widget.title.label = definition.title; }
        if (!widget.title.caption) { widget.title.caption = definition.title; }
        widget.title.closable = true;
        return widget;
    }
}
