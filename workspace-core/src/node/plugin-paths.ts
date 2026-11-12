import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Directory name under the user's home where Icebox keeps plugin state. */
export const USER_DATA_DIR_NAME = '.icebox';

/**
 * Resolves the directories scanned for `plugin.json`.
 *
 * Built-in plugins ship inside the Icebox checkout/installation; user-installed
 * plugins live in the per-user data directory. An explicit
 * `ICEBOX_PLUGINS_DIR` environment variable takes precedence over both, which
 * is what development and packaging use to point at a prepared folder.
 */
export interface PluginRoot {
    readonly path: string;
    /**
     * True when the folder ships with the installation.
     *
     * Built-in plugins start enabled and need no trust decision; everything else
     * is third-party code and stays off until the user accepts the warning. The
     * `ICEBOX_PLUGINS_DIR` override counts as third-party on purpose: it points
     * at a folder someone prepared, not at what this installation shipped.
     */
    readonly builtIn: boolean;
}

export async function resolvePluginRoots(appPath: string): Promise<PluginRoot[]> {
    const candidates: PluginRoot[] = [];

    const override = process.env.ICEBOX_PLUGINS_DIR;
    if (override && override.trim().length > 0) {
        candidates.push({ path: path.resolve(override.trim()), builtIn: false });
    }

    // `appPath` is the application package root (e.g. `browser-app`). The
    // monorepo keeps built-in plugins one level up, in `<repo>/plugins`.
    candidates.push({ path: path.resolve(appPath, '..', 'plugins'), builtIn: true });
    candidates.push({ path: path.resolve(appPath, 'plugins'), builtIn: true });

    candidates.push({ path: path.join(os.homedir(), USER_DATA_DIR_NAME, 'plugins'), builtIn: false });

    const roots: PluginRoot[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate.path);
        if (seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        try {
            const stats = await fs.stat(resolved);
            if (stats.isDirectory()) {
                roots.push({ path: resolved, builtIn: candidate.builtIn });
            }
        } catch {
            // Missing roots are the normal case for a fresh install.
        }
    }
    return roots;
}

/** Location of the persisted plugin state file. */
export function resolveStateFile(): string {
    const override = process.env.ICEBOX_STATE_DIR;
    const base = override && override.trim().length > 0
        ? path.resolve(override.trim())
        : path.join(os.homedir(), USER_DATA_DIR_NAME);
    return path.join(base, 'plugins.json');
}
