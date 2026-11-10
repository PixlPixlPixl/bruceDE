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

/** A registered panel definition together with the plugin that owns it. */
export interface RegisteredWorkspacePanel {
    readonly definition: WorkspacePanelDefinition;
    /** Plugin id, or `undefined` for host-owned panels. */
    readonly owner: string | undefined;
}

@injectable()
export class WorkspacePanelRegistry {
    protected readonly definitions = new Map<string, RegisteredWorkspacePanel>();
    protected readonly instanceCounters = new Map<string, number>();
    protected readonly owners = new Map<string, Set<string>>();

    /**
     * Registers a panel type. `owner` links the type to a plugin so the host can
     * close every instance it opened when that plugin unloads.
     */
    registerPanel(definition: WorkspacePanelDefinition, owner?: string): () => void {
        if (!definition.id.trim()) {
            throw new Error('A workspace panel definition must have a non-empty id.');
        }
        if (this.definitions.has(definition.id)) {
            throw new Error('Workspace panel already registered: ' + definition.id);
        }
        this.definitions.set(definition.id, { definition, owner });
        if (owner) {
            let owned = this.owners.get(owner);
            if (!owned) {
                owned = new Set();
                this.owners.set(owner, owned);
            }
            owned.add(definition.id);
        }
        return () => {
            if (this.definitions.get(definition.id)?.definition === definition) {
                this.definitions.delete(definition.id);
                if (owner) {
                    this.owners.get(owner)?.delete(definition.id);
                }
            }
        };
    }

    getPanelDefinitions(): readonly WorkspacePanelDefinition[] {
        return Array.from(this.definitions.values(), entry => entry.definition);
    }

    getRegisteredPanel(panelTypeId: string): RegisteredWorkspacePanel | undefined {
        return this.definitions.get(panelTypeId);
    }

    getOwner(panelTypeId: string): string | undefined {
        return this.definitions.get(panelTypeId)?.owner;
    }

    /** Panel type ids registered by a plugin. */
    getPanelTypesByOwner(owner: string): readonly string[] {
        return Array.from(this.owners.get(owner) ?? []);
    }

    async createPanel(panelTypeId: string): Promise<Widget> {
        const registered = this.definitions.get(panelTypeId);
        if (!registered) {
            throw new Error('Unknown workspace panel type: ' + panelTypeId);
        }
        const { definition } = registered;
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
