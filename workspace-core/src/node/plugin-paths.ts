import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Directory name under the user's home where BruceDE keeps plugin state. */
export const USER_DATA_DIR_NAME = '.brucede';

/**
 * Resolves the directories scanned for `plugin.json`.
 *
 * Built-in plugins ship inside the BruceDE checkout/installation; user-installed
 * plugins live in the per-user data directory. An explicit
 * `BRUCEDE_PLUGINS_DIR` environment variable takes precedence over both, which
 * is what development and packaging use to point at a prepared folder.
 */
export async function resolvePluginRoots(appPath: string): Promise<string[]> {
    const candidates: string[] = [];

    const override = process.env.BRUCEDE_PLUGINS_DIR;
    if (override && override.trim().length > 0) {
        candidates.push(path.resolve(override.trim()));
    }

    // `appPath` is the application package root (e.g. `browser-app`). The
    // monorepo keeps built-in plugins one level up, in `<repo>/plugins`.
    candidates.push(path.resolve(appPath, '..', 'plugins'));
    candidates.push(path.resolve(appPath, 'plugins'));

    candidates.push(path.join(os.homedir(), USER_DATA_DIR_NAME, 'plugins'));

    const roots: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        try {
            const stats = await fs.stat(resolved);
            if (stats.isDirectory()) {
                roots.push(resolved);
            }
        } catch {
            // Missing roots are the normal case for a fresh install.
        }
    }
    return roots;
}

/** Location of the persisted plugin state file. */
export function resolveStateFile(): string {
    const override = process.env.BRUCEDE_STATE_DIR;
    const base = override && override.trim().length > 0
        ? path.resolve(override.trim())
        : path.join(os.homedir(), USER_DATA_DIR_NAME);
    return path.join(base, 'plugins.json');
}
