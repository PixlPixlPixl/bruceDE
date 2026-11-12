import { promises as fs } from 'fs';
import * as path from 'path';
import type { PluginManifest } from '@icebox/plugin-api';
import { ICEBOX_WORKSPACE_PLUGIN_ID } from '@icebox/plugin-api';
import { PluginManifestError, satisfiesVersion, validatePluginManifest } from '@icebox/plugin-runtime';
import type { PluginRoot } from './plugin-paths.js';
import {
    PLUGIN_ASSET_PREFIX,
    type PluginDescriptor,
    type PluginDiagnostic
} from '../common/plugin-host-protocol.js';

export interface DiscoveredPlugin {
    readonly manifest: PluginManifest;
    /** Absolute plugin folder. */
    readonly directory: string;
    /** True when the folder ships with the installation; see `PluginRoot`. */
    readonly builtIn: boolean;
    readonly manifestPath: string;
    /** Absolute path of each declared entrypoint that exists on disk. */
    readonly frontendEntrypoint?: string;
    readonly backendEntrypoint?: string;
}

export interface DiscoveryResult {
    readonly plugins: readonly DiscoveredPlugin[];
    readonly diagnostics: readonly PluginDiagnostic[];
}

const MANIFEST_FILE = 'plugin.json';

/**
 * How many grouping levels sit above a plugin folder.
 *
 * `plugins/agents/gemini` is one grouping folder above the plugin, which is what
 * keeps a growing list of agent plugins from crowding the plugin root. A folder
 * that itself holds a manifest is a plugin and is never descended into, so
 * `src/` and `dist/` can never be mistaken for plugins.
 */
const MAX_GROUPING_DEPTH = 1;

/**
 * Scans every plugin root for `plugin.json` manifests.
 *
 * Plugins are folders, not package installs, so discovery is a directory walk:
 * manifests in the root, plus one level of grouping folders. Failures are
 * collected as diagnostics instead of being thrown: one broken third-party
 * plugin must not prevent the workspace from starting.
 */
export async function discoverPlugins(roots: readonly PluginRoot[]): Promise<DiscoveryResult> {
    const plugins: DiscoveredPlugin[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    const seenIds = new Map<string, string>();

    const accept = async (root: PluginRoot, directory: string, manifestPath: string, raw: string): Promise<void> => {
        let manifest: PluginManifest;
        try {
            manifest = validatePluginManifest(JSON.parse(raw), manifestPath);
        } catch (error) {
            diagnostics.push({
                directory,
                message: error instanceof PluginManifestError ? error.message : describeError(error)
            });
            return;
        }

        const previous = seenIds.get(manifest.id);
        if (previous) {
            diagnostics.push({
                pluginId: manifest.id,
                directory,
                message: `Duplicate plugin id "${manifest.id}"; already discovered at ${previous}. Ignoring this copy.`
            });
            return;
        }
        seenIds.set(manifest.id, directory);

        const entrypoints = await resolveEntrypoints(directory, manifest, diagnostics);
        plugins.push({ manifest, directory, builtIn: root.builtIn, manifestPath, ...entrypoints });
    };

    const scan = async (root: PluginRoot, directory: string, depth: number): Promise<void> => {
        let entries: string[];
        try {
            entries = await fs.readdir(directory);
        } catch (error) {
            diagnostics.push({
                directory,
                message: `Cannot read plugin ${depth === 0 ? 'root' : 'folder'}: ${describeError(error)}`
            });
            return;
        }

        entries.sort();
        for (const entryName of entries) {
            // Hidden folders and installed trees are never grouping folders.
            if (entryName.startsWith('.') || entryName === 'node_modules') {
                continue;
            }
            const child = path.join(directory, entryName);
            let stats;
            try {
                stats = await fs.stat(child);
            } catch {
                continue;
            }
            if (!stats.isDirectory()) {
                continue;
            }

            const manifestPath = path.join(child, MANIFEST_FILE);
            let raw: string;
            try {
                raw = await fs.readFile(manifestPath, 'utf8');
            } catch {
                // No manifest: either a grouping folder, or not a plugin at all.
                if (depth < MAX_GROUPING_DEPTH) {
                    await scan(root, child, depth + 1);
                }
                continue;
            }
            await accept(root, child, manifestPath, raw);
        }
    };

    for (const root of roots) {
        await scan(root, root.path, 0);
    }

    resolveCrossDependencies(plugins, diagnostics);
    plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { plugins, diagnostics };
}

async function resolveEntrypoints(
    directory: string,
    manifest: PluginManifest,
    diagnostics: PluginDiagnostic[]
): Promise<{ frontendEntrypoint?: string; backendEntrypoint?: string }> {
    const resolve = async (relative: string | undefined, side: string): Promise<string | undefined> => {
        if (!relative) {
            return undefined;
        }
        const absolute = path.resolve(directory, relative);
        const relativeToPlugin = path.relative(directory, absolute);
        if (relativeToPlugin.startsWith('..') || path.isAbsolute(relativeToPlugin)) {
            diagnostics.push({
                pluginId: manifest.id,
                directory,
                message: `Entrypoint "${relative}" escapes the plugin folder.`
            });
            return undefined;
        }
        try {
            const stats = await fs.stat(absolute);
            if (!stats.isFile()) {
                throw new Error('not a file');
            }
            return absolute;
        } catch {
            diagnostics.push({
                pluginId: manifest.id,
                directory,
                message: `Declared ${side} entrypoint "${relative}" does not exist. Run the plugin build.`
            });
            return undefined;
        }
    };

    return {
        frontendEntrypoint: await resolve(manifest.entrypoints.frontend, 'frontend'),
        backendEntrypoint: await resolve(manifest.entrypoints.backend, 'backend')
    };
}

/**
 * Reports dependency ids that no discovered plugin satisfies, or that resolve
 * to a plugin version outside the declared range.
 *
 * The host workspace (`icebox.workspace`) is a first-class service, not a
 * plugin, so it is always considered available. A plugin with an unsatisfied
 * dependency is still exposed so the manager can show the problem instead of
 * silently dropping it.
 */
function resolveCrossDependencies(
    plugins: readonly DiscoveredPlugin[],
    diagnostics: PluginDiagnostic[]
): void {
    const byId = new Map<string, DiscoveredPlugin>(plugins.map(plugin => [plugin.manifest.id, plugin]));
    for (const plugin of plugins) {
        for (const [dependencyId, range] of Object.entries(plugin.manifest.dependencies ?? {})) {
            if (dependencyId === ICEBOX_WORKSPACE_PLUGIN_ID) {
                continue;
            }
            const dependency = byId.get(dependencyId);
            if (!dependency) {
                diagnostics.push({
                    pluginId: plugin.manifest.id,
                    directory: plugin.directory,
                    message: `Missing plugin dependency "${dependencyId}".`
                });
                continue;
            }
            if (!satisfiesVersion(dependency.manifest.version, range)) {
                diagnostics.push({
                    pluginId: plugin.manifest.id,
                    directory: plugin.directory,
                    message: `Plugin dependency "${dependencyId}" needs "${range}" but ${dependency.manifest.version} is installed.`
                });
            }
        }
    }
}

/** Builds the renderer-facing descriptor, including the served asset URL. */
export function toDescriptor(plugin: DiscoveredPlugin): PluginDescriptor {
    const contributions = plugin.manifest.contributes;
    const frontendPath = plugin.manifest.entrypoints.frontend;
    return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        apiVersion: plugin.manifest.apiVersion,
        description: plugin.manifest.description,
        builtIn: plugin.builtIn,
        directory: plugin.directory,
        frontendUrl: plugin.frontendEntrypoint && frontendPath
            ? `${PLUGIN_ASSET_PREFIX}/${encodeURIComponent(plugin.manifest.id)}/${normalizeRelativePath(frontendPath)}`
            : undefined,
        backendEntrypoint: plugin.backendEntrypoint,
        dependencyIds: Object.keys(plugin.manifest.dependencies ?? {}),
        panels: (contributions?.panels ?? []).map(panel => ({
            id: panel.id,
            title: panel.title,
            icon: panel.icon
        })),
        commands: (contributions?.commands ?? []).map(command => ({
            id: command.id,
            title: command.title
        })),
        services: contributions?.services ?? [],
        agents: contributions?.agents ?? []
    };
}

export function toPosixPath(value: string): string {
    return value.replace(/\\/g, '/');
}

/**
 * Manifest entrypoints are written as `./dist/frontend.js`; the served URL must
 * not carry the leading `./` or the browser asks for a normalization the asset
 * route does not perform.
 */
export function normalizeRelativePath(value: string): string {
    return toPosixPath(value).replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
