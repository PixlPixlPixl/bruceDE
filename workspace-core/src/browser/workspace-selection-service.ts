import { inject, injectable } from '@theia/core/shared/inversify';
import {
    BRUCE_WORKSPACE_PLUGIN_ID,
    WORKSPACE_EVENT_IDS,
    WORKSPACE_SERVICE_IDS,
    type PluginDisposer,
    type ResourceSelection,
    type WorkspaceSelectionService as WorkspaceSelectionContract
} from '@brucede/plugin-api';
import { PluginEventBus, PluginServiceRegistry } from '../common/plugin-registries.js';

/**
 * The host's shared selection state.
 *
 * It is the single source of truth for "what is the user looking at", so a
 * plugin never has to know which other plugin set it. The host provides it
 * under {@link WORKSPACE_SERVICE_IDS.selection} before any plugin activates,
 * and mirrors every change onto {@link WORKSPACE_EVENT_IDS.selectionChanged}
 * so event-driven plugins get the same update.
 */
@injectable()
export class WorkspaceSelectionService implements WorkspaceSelectionContract {
    protected selection: ResourceSelection | undefined;
    protected readonly listeners = new Set<(selection: ResourceSelection | undefined) => void>();

    constructor(
        @inject(PluginEventBus) protected readonly events: PluginEventBus,
        @inject(PluginServiceRegistry) protected readonly services: PluginServiceRegistry
    ) { }

    /** Publishes the service under the host's owner id. */
    install(): PluginDisposer {
        return this.services.provide(BRUCE_WORKSPACE_PLUGIN_ID, WORKSPACE_SERVICE_IDS.selection, this);
    }

    get(): ResourceSelection | undefined {
        return this.selection;
    }

    set(selection: ResourceSelection | undefined): void {
        if (sameSelection(this.selection, selection)) {
            return;
        }
        this.selection = selection;
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(selection);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('[workspace] Selection listener threw:', error);
            }
        }
        this.events.emit(WORKSPACE_EVENT_IDS.selectionChanged, selection);
    }

    onDidChange(listener: (selection: ResourceSelection | undefined) => void): PluginDisposer {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}

function sameSelection(
    left: ResourceSelection | undefined,
    right: ResourceSelection | undefined
): boolean {
    if (left === right) {
        return true;
    }
    if (!left || !right) {
        return false;
    }
    return left.uri === right.uri && sameRanges(left.ranges, right.ranges);
}

function sameRanges(
    left: ResourceSelection['ranges'],
    right: ResourceSelection['ranges']
): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((range, index) => {
        const other = right[index];
        return range.start.line === other.start.line
            && range.start.character === other.start.character
            && range.end.line === other.end.line
            && range.end.character === other.end.character;
    });
}
