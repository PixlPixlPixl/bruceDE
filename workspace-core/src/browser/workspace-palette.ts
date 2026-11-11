import { injectable } from '@theia/core/shared/inversify';
import { Disposable } from '@theia/core/lib/common/disposable';

/**
 * The set of commands the F1 menu offers.
 *
 * F1 is a workspace menu, not a mirror of the command registry: it exists to
 * open panels and to save or load a layout, and everything else belongs in the
 * application's own UI (a panel, a button, a keystroke) rather than a searchable
 * list of every command the renderer happens to know. The registry keeps every
 * command executable; only membership here decides whether F1 lists it.
 *
 * Members are added where the command is created, so a plugin's panel command
 * appears the moment the plugin registers it and disappears when it unloads.
 */
@injectable()
export class WorkspacePalette {
    protected readonly commandIds = new Set<string>();

    /** Adds commands to the menu. The returned disposable removes them again. */
    include(...commandIds: string[]): Disposable {
        for (const commandId of commandIds) {
            this.commandIds.add(commandId);
        }
        return Disposable.create(() => {
            for (const commandId of commandIds) {
                this.commandIds.delete(commandId);
            }
        });
    }

    /** Whether F1 should list the given command. */
    shows(commandId: string): boolean {
        return this.commandIds.has(commandId);
    }
}
