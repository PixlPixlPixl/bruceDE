import { homedir } from 'node:os';
import type { BackendPluginAPI } from '@brucede/plugin-api';
import { FILE_ROOTS_SERVICE, type FileRoots, type FileRootsService } from '../shared.js';

/**
 * Backend half of the file browser.
 *
 * The panel itself is renderer code: it lists directories through the host's
 * `workspace.resources` service. What the renderer cannot learn on its own is an
 * absolute path to start from, so this plugin publishes the smallest possible
 * service that answers that question.
 *
 * The browser opens in the user's home directory. The process working directory
 * is reported alongside it — that is where the application was launched, which
 * is a useful fact but a poor place to browse from.
 */
export function activate(api: BackendPluginAPI): void {
    const service: FileRootsService = {
        roots(): FileRoots {
            const cwd = api.workspace.cwd;
            return { cwd, roots: [homedir()] };
        }
    };
    api.services.provide(FILE_ROOTS_SERVICE, service);
}
