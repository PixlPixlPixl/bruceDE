import { inject, injectable } from '@theia/core/shared/inversify';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    ICEBOX_WORKSPACE_PLUGIN_ID,
    WORKSPACE_SERVICE_IDS,
    type PluginDisposer,
    type WorkspaceDialogsService
} from '@icebox/plugin-api';
import { PluginServiceRegistry } from '../common/plugin-registries.js';

/**
 * The host's native dialogs.
 *
 * Plugins cannot import Theia's file dialog themselves: it needs the shell's
 * parent window, its labels and its platform quirks. This service is the curated
 * way to ask for a folder, so a plugin (Projects) can add a project without
 * building a picker or reading the filesystem in the renderer.
 */
@injectable()
export class WorkspaceDialogService implements WorkspaceDialogsService {
    constructor(
        @inject(FileDialogService) protected readonly dialogs: FileDialogService,
        @inject(FileService) protected readonly files: FileService,
        @inject(PluginServiceRegistry) protected readonly services: PluginServiceRegistry
    ) { }

    /** Publishes the service under the host's owner id. */
    install(): PluginDisposer {
        return this.services.provide(ICEBOX_WORKSPACE_PLUGIN_ID, WORKSPACE_SERVICE_IDS.dialogs, this);
    }

    async pickDirectory(options?: { readonly title?: string }): Promise<string | undefined> {
        const uri = await this.dialogs.showOpenDialog({
            title: options?.title ?? 'Select a folder',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });
        if (!uri) {
            return undefined;
        }
        return this.files.fsPath(uri);
    }
}
