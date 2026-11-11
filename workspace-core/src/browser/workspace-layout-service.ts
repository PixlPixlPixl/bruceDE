import { inject, injectable } from '@theia/core/shared/inversify';
import { Widget } from '@lumino/widgets';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { StatefulWidget } from '@theia/core/lib/browser/shell/shell-layout-restorer';
import { WidgetConstructionOptions, WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { nls } from '@theia/core/lib/common/nls';
import { QuickInputService } from '@theia/core/lib/common/quick-pick-service';
import { WorkspacePalette } from './workspace-palette.js';

export const SAVE_LAYOUT: Command = {
    id: 'icebox.layout.save',
    label: nls.localize('icebox/layout', 'Save Layout')
};

export const LOAD_LAYOUT: Command = {
    id: 'icebox.layout.load',
    label: nls.localize('icebox/layout', 'Load Layout')
};

/** Storage key holding every named layout. Layouts are small JSON strings. */
const STORAGE_KEY = 'icebox:saved-layouts';

/** A widget as stored in a layout: how to build it, plus its own state. */
interface WidgetDescription {
    readonly constructionOptions: WidgetConstructionOptions;
    readonly innerWidgetState?: unknown;
}

/** One named layout, exactly as the user saved it. */
interface StoredLayout {
    readonly name: string;
    /** The shell layout, with widgets replaced by their construction options. */
    readonly layout: string;
    readonly savedAt: number;
}

/**
 * "Save Layout" and "Load Layout": named snapshots of the workspace arrangement.
 *
 * A layout is Theia's own shell layout data, with every widget replaced by the
 * description `WidgetManager` can rebuild it from. That is the same information
 * the shell restores on startup, so loading a saved layout brings back the same
 * panels, in the same dock areas, with the same per-panel state — including the
 * agent and working directory an Agent Chat panel was opened with.
 *
 * Restoring goes through `ApplicationShell.setLayoutData`, the call perspective
 * switching uses to replace a running shell's arrangement, so nothing has to be
 * reloaded to apply it.
 */
@injectable()
export class WorkspaceLayoutService implements CommandContribution {
    constructor(
        @inject(ApplicationShell) protected readonly shell: ApplicationShell,
        @inject(WidgetManager) protected readonly widgets: WidgetManager,
        @inject(StorageService) protected readonly storage: StorageService,
        @inject(QuickInputService) protected readonly quickInput: QuickInputService,
        @inject(MessageService) protected readonly messages: MessageService,
        @inject(WorkspacePalette) protected readonly palette: WorkspacePalette
    ) { }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(SAVE_LAYOUT, { execute: () => this.save() });
        commands.registerCommand(LOAD_LAYOUT, { execute: () => this.load() });
        this.palette.include(SAVE_LAYOUT.id, LOAD_LAYOUT.id);
    }

    /** Asks for a name, then snapshots the current arrangement under it. */
    async save(): Promise<void> {
        const stored = await this.storedLayouts();
        const name = await this.quickInput.input({
            title: SAVE_LAYOUT.label,
            prompt: nls.localize('icebox/layout', 'Save the current workspace layout as'),
            placeHolder: nls.localize('icebox/layout', 'Layout name'),
            validateInput: async value => (value.trim() ? undefined : nls.localize('icebox/layout', 'Enter a name'))
        });
        if (name === undefined) {
            return;
        }
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        const entry: StoredLayout = {
            name: trimmed,
            layout: this.deflate(this.shell.getLayoutData()),
            savedAt: Date.now()
        };
        // Same name saves over the old snapshot instead of adding a duplicate.
        const kept = stored.filter(candidate => candidate.name.toLowerCase() !== trimmed.toLowerCase());
        await this.storage.setData(STORAGE_KEY, [...kept, entry].sort((a, b) => a.name.localeCompare(b.name)));
        this.messages.info(nls.localize('icebox/layout', 'Saved layout "{0}".', trimmed));
    }

    /** Asks which layout to restore, then applies it to the running shell. */
    async load(): Promise<void> {
        const stored = await this.storedLayouts();
        if (stored.length === 0) {
            this.messages.warn(nls.localize('icebox/layout', 'No saved layouts yet. Use "Save Layout" first.'));
            return;
        }
        const picked = await this.quickInput.showQuickPick(
            stored.map(entry => ({
                label: entry.name,
                description: new Date(entry.savedAt).toLocaleString(),
                entry
            })),
            {
                title: LOAD_LAYOUT.label,
                placeholder: nls.localize('icebox/layout', 'Select a layout to restore')
            }
        );
        if (!picked) {
            return;
        }
        try {
            await this.shell.setLayoutData(await this.inflate(picked.entry.layout));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.messages.error(nls.localize('icebox/layout', 'Could not load layout "{0}": {1}', picked.entry.name, reason));
            return;
        }
        this.messages.info(nls.localize('icebox/layout', 'Loaded layout "{0}".', picked.entry.name));
    }

    protected async storedLayouts(): Promise<StoredLayout[]> {
        const data = await this.storage.getData<unknown>(STORAGE_KEY);
        if (!Array.isArray(data)) {
            return [];
        }
        const layouts: StoredLayout[] = [];
        for (const candidate of data) {
            if (
                candidate
                && typeof candidate === 'object'
                && typeof (candidate as StoredLayout).name === 'string'
                && typeof (candidate as StoredLayout).layout === 'string'
            ) {
                layouts.push({
                    name: (candidate as StoredLayout).name,
                    layout: (candidate as StoredLayout).layout,
                    savedAt: Number((candidate as StoredLayout).savedAt) || 0
                });
            }
        }
        return layouts;
    }

    /**
     * Replaces widget instances with their construction options.
     *
     * Shell layout data is a tree of Lumino configurations holding live widget
     * references. The replacer rewrites the two keys that can hold one — a side
     * panel's `widget` and a tab area's `widgets` — so `JSON.stringify` walks the
     * tree without ever serializing a widget. It runs at every depth, which also
     * covers widget state that itself contains widgets.
     */
    protected deflate(layout: ApplicationShell.LayoutData): string {
        return JSON.stringify(layout, (property, value: unknown) => {
            if (property === 'widget') {
                return this.describe(value as Widget);
            }
            if (property === 'widgets') {
                const descriptions: WidgetDescription[] = [];
                for (const widget of value as Widget[]) {
                    const description = this.describe(widget);
                    if (description) {
                        descriptions.push(description);
                    }
                }
                return descriptions;
            }
            return value;
        });
    }

    /** The description of one widget, or `undefined` if it cannot be rebuilt. */
    protected describe(widget: Widget): WidgetDescription | undefined {
        const constructionOptions = this.widgets.getDescription(widget);
        if (!constructionOptions) {
            return undefined;
        }
        if (StatefulWidget.is(widget)) {
            const innerWidgetState = widget.storeState();
            return innerWidgetState ? { constructionOptions, innerWidgetState } : undefined;
        }
        return { constructionOptions };
    }

    /** Rebuilds the stored tree, replacing descriptions with real widgets. */
    protected async inflate(layout: string): Promise<ApplicationShell.LayoutData> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(layout);
        } catch {
            throw new Error(nls.localize('icebox/layout', 'the saved layout is not valid JSON'));
        }
        return await this.materialize(parsed) as ApplicationShell.LayoutData;
    }

    protected async materialize(node: unknown): Promise<unknown> {
        if (Array.isArray(node)) {
            return Promise.all(node.map(item => this.materialize(item)));
        }
        if (!node || typeof node !== 'object') {
            return node;
        }
        const description = node as Partial<WidgetDescription> & Record<string, unknown>;
        if (description.constructionOptions) {
            return this.materializeWidget(description as WidgetDescription);
        }
        const rebuilt: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(description)) {
            rebuilt[key] = await this.materialize(value);
        }
        return rebuilt;
    }

    /**
     * Builds one widget from its description.
     *
     * A layout is all-or-nothing: a shell cannot be restored with a hole where
     * a tab used to be, so an unavailable widget aborts the load instead of
     * silently dropping the tab.
     */
    protected async materializeWidget(description: WidgetDescription): Promise<Widget> {
        const { factoryId, options } = description.constructionOptions;
        const widget = await this.widgets.getOrCreateWidget<Widget>(factoryId, options);
        if (widget.isDisposed) {
            throw new Error(nls.localize('icebox/layout', 'the "{0}" panel is no longer available', factoryId));
        }
        if (StatefulWidget.is(widget) && description.innerWidgetState !== undefined && !widget.isAttached) {
            // Only a widget that does not exist yet needs its stored state replayed.
            // A widget already attached to the shell is live, and replaying its state
            // would repeat side effects it has already done: `TerminalWidget.restoreState`
            // re-attaches to the terminal server's channel for that id, which the running
            // terminal still holds.
            widget.restoreState(await this.materialize(description.innerWidgetState) as object);
        }
        return widget;
    }
}
