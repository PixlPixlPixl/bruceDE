import type { BackendPluginAPI } from '@brucede/plugin-api';
import { FILE_ROOTS_SERVICE, type FileRoots, type FileRootsService } from '../shared.js';

/**
 * Backend half of the file browser.
 *
 * The panel itself is renderer code: it lists directories through the host's
 * `workspace.resources` service. The only thing the renderer cannot learn on its
 * own is where the process is running, so this plugin publishes the smallest
 * possible service that answers that question.
 */
export function activate(api: BackendPluginAPI): void {
    const service: FileRootsService = {
        roots(): FileRoots {
            const cwd = api.workspace.cwd;
            return { cwd, roots: [cwd] };
        }
    };
    api.services.provide(FILE_ROOTS_SERVICE, service);
}
