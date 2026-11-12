#!/usr/bin/env node
/**
 * Builds every plugin folder that contains a `plugin.json`.
 *
 * Run from the repository root: `node packages/plugin-build/build-all.mjs`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..');
const pluginsRoot = path.join(repositoryRoot, 'plugins');

async function main() {
    try {
        await fs.access(pluginsRoot);
    } catch (error) {
        throw new Error(`Cannot read plugin directory ${pluginsRoot}: ${message(error)}`);
    }

    const failures = [];
    let built = 0;

    /** Mirrors `plugin-discovery.ts`: root manifests, plus one grouping level. */
    const collect = async (directory, depth) => {
        const found = [];
        for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
            .filter(candidate => candidate.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const pluginDir = path.join(directory, entry.name);
            try {
                await fs.access(path.join(pluginDir, 'plugin.json'));
            } catch {
                // A folder without a manifest is a grouping folder (plugins/agents).
                if (depth < 1) {
                    found.push(...await collect(pluginDir, depth + 1));
                }
                continue;
            }
            found.push(pluginDir);
        }
        return found;
    };

    const pluginDirs = await collect(pluginsRoot, 0);
    for (const pluginDir of pluginDirs) {
        try {
            await buildPlugin(pluginDir);
            built++;
        } catch (error) {
            failures.push(`${path.relative(pluginsRoot, pluginDir)}: ${message(error)}`);
        }
    }

    if (failures.length > 0) {
        console.error(`[plugin-build] ${failures.length} plugin(s) failed:`);
        for (const failure of failures) {
            console.error(`  - ${failure}`);
        }
        process.exit(1);
    }
    console.log(`[plugin-build] Built ${built} plugin(s).`);
}

function message(error) {
    return error instanceof Error ? error.message : String(error);
}

main().catch(error => {
    console.error('[plugin-build]', message(error));
    process.exit(1);
});
