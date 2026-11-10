import { inject, injectable } from '@theia/core/shared/inversify';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { Widget } from '@lumino/widgets';

/**
 * Factory id every workspace panel instance is created under.
 *
 * A single host factory is used for all panel types so `WidgetManager` owns the
 * instances. That is what makes Theia's layout restorer able to persist and
 * rebuild them: it saves `{ factoryId, options }` for widgets the manager
 * created, and asks the factory to create them again on the next start.
 */
export const WORKSPACE_PANEL_FACTORY_ID = 'bruce.workspace.panel';

/** Serializable construction options of one workspace panel instance. */
export interface WorkspacePanelWidgetOptions {
    /** Registered panel type, e.g. `bruce.terminal:terminal.main`. */
    readonly panelTypeId: string;
    /** Stable instance id, e.g. `bruce.terminal:terminal.main.1`. */
    readonly instanceId: string;
}

/** Validates options that were read back from persisted layout data. */
export function isWorkspacePanelWidgetOptions(value: unknown): value is WorkspacePanelWidgetOptions {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.panelTypeId === 'string'
        && record.panelTypeId.trim().length > 0
        && typeof record.instanceId === 'string'
        && record.instanceId.trim().length > 0;
}

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
    /** Open widget id → panel type id. Includes restored instances. */
    protected readonly instances = new Map<string, string>();

    constructor(@inject(WidgetManager) protected readonly widgetManager: WidgetManager) { }

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

    /**
     * Creates a panel instance through the host's `WidgetManager`.
     *
     * Passing an explicit `instanceId` re-opens an existing instance or
     * re-creates one from a persisted layout. Forgetting a layout: a saved
     * widget whose panel type is no longer registered resolves to an
     * "unavailable" panel instead of throwing, so one disabled plugin cannot
     * break the whole restored workspace.
     */
    async createPanel(panelTypeId: string, instanceId?: string): Promise<Widget> {
        if (!this.definitions.has(panelTypeId)) {
            throw new Error('Unknown workspace panel type: ' + panelTypeId);
        }
        const resolvedId = instanceId ?? this.nextInstanceId(panelTypeId);
        const options: WorkspacePanelWidgetOptions = { panelTypeId, instanceId: resolvedId };
        const widget = await this.widgetManager.getOrCreateWidget<Widget>(
            WORKSPACE_PANEL_FACTORY_ID,
            options
        );
        this.track(widget, panelTypeId);
        return widget;
    }

    /**
     * Builds the widget for `WidgetManager`. Called by the host factory only.
     *
     * The panel type may be missing when a persisted layout references a plugin
     * that is currently disabled or uninstalled; the caller supplies the
     * fallback widget for that case.
     */
    async instantiate(
        instanceId: string,
        panelTypeId: string,
        unavailable: (options: WorkspacePanelWidgetOptions) => Widget
    ): Promise<Widget> {
        const registered = this.definitions.get(panelTypeId);
        const widget = registered
            ? await registered.definition.createWidget(instanceId)
            : unavailable({ panelTypeId, instanceId });
        const title = registered?.definition.title ?? instanceId;
        widget.id = instanceId;
        if (!widget.title.label) {
            widget.title.label = title;
        }
        if (!widget.title.caption) {
            widget.title.caption = title;
        }
        widget.title.closable = true;
        this.track(widget, panelTypeId);
        return widget;
    }

    /** Instance ids of a panel type that are currently open. */
    getOpenInstances(panelTypeId: string): readonly string[] {
        return Array.from(this.instances.entries())
            .filter(([, typeId]) => typeId === panelTypeId)
            .map(([instanceId]) => instanceId);
    }

    /** Instance ids owned by a plugin, across all of its panel types. */
    getOpenInstancesByOwner(owner: string): readonly string[] {
        const ownedTypes = new Set(this.getPanelTypesByOwner(owner));
        return Array.from(this.instances.entries())
            .filter(([, typeId]) => ownedTypes.has(typeId))
            .map(([instanceId]) => instanceId);
    }

    /** Panel type of an open instance, if known. */
    getPanelTypeOfInstance(instanceId: string): string | undefined {
        return this.instances.get(instanceId);
    }

    /** Stops tracking an instance that is no longer part of the shell. */
    forgetInstance(instanceId: string): void {
        this.instances.delete(instanceId);
    }

    protected nextInstanceId(panelTypeId: string): string {
        const next = (this.instanceCounters.get(panelTypeId) ?? 0) + 1;
        this.instanceCounters.set(panelTypeId, next);
        return panelTypeId + '.' + next;
    }

    protected track(widget: Widget, panelTypeId: string): void {
        this.reserveCounter(panelTypeId, widget.id);
        if (this.instances.has(widget.id)) {
            return;
        }
        this.instances.set(widget.id, panelTypeId);
        widget.disposed.connect(() => this.instances.delete(widget.id));
    }

    /**
     * Keeps generated instance ids unique after a layout restore, so a restored
     * `…​.1` does not collide with the next instance opened in this session.
     */
    protected reserveCounter(panelTypeId: string, instanceId: string): void {
        const prefix = panelTypeId + '.';
        if (!instanceId.startsWith(prefix)) {
            return;
        }
        const parsed = Number(instanceId.slice(prefix.length));
        if (!Number.isInteger(parsed) || parsed <= 0) {
            return;
        }
        const current = this.instanceCounters.get(panelTypeId) ?? 0;
        if (parsed > current) {
            this.instanceCounters.set(panelTypeId, parsed);
        }
    }
}
