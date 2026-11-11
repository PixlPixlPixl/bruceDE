#!/usr/bin/env node
/**
 * Writes the application's own name into the generated HTML titles.
 *
 * `theia build` writes these files from its own templates: the main window title
 * comes from `theia.frontend.config.applicationName`, but the secondary-window
 * title is hardcoded in Theia's frontend generator ("Theia — Secondary Window"),
 * so it can only be branded after generation. Running this after every build
 * keeps the titles correct without patching a dependency.
 *
 * Usage: node scripts/brand-generated-html.mjs <app directory>
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const THEIA_SECONDARY_TITLE = /<title>\s*Theia\s*—\s*Secondary Window\s*<\/title>/i;
const TITLE = /<title>.*?<\/title>/s;

/** Files `theia build` writes, relative to the application directory. */
const INDEX_FILES = ['src-gen/frontend/index.html', 'lib/frontend/index.html'];
const SECONDARY_FILES = ['src-gen/frontend/secondary-window.html', 'lib/frontend/secondary-window.html'];

/**
 * The name the shell shows, so branding matches what the configuration already
 * says instead of a second hardcoded copy.
 */
async function applicationName(appDir) {
    let manifest;
    try {
        manifest = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read the application manifest in ${appDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return manifest?.theia?.frontend?.config?.applicationName ?? 'Icebox';
}

async function retitle(file, title) {
    let html;
    try {
        html = await readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    const updated = html.replace(TITLE, `<title>${title}</title>`);
    if (updated === html) {
        return false;
    }
    await writeFile(file, updated);
    return true;
}

const appDir = path.resolve(process.argv[2] ?? '.');
const name = await applicationName(appDir);
const changed = [];

for (const file of INDEX_FILES) {
    if (await retitle(path.join(appDir, file), name)) {
        changed.push(file);
    }
}
for (const file of SECONDARY_FILES) {
    const absolute = path.join(appDir, file);
    try {
        const html = await readFile(absolute, 'utf8');
        // The generic retitle would leave other windows numbered, so only the
        // generated secondary title is rewritten here.
        if (!THEIA_SECONDARY_TITLE.test(html) && !html.includes(`<title>${name} — Secondary Window</title>`)) {
            continue;
        }
        if (await retitle(absolute, `${name} — Secondary Window`)) {
            changed.push(file);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

console.log(changed.length > 0
    ? `[brand] titles in ${changed.join(', ')} now read "${name}".`
    : `[brand] titles in ${appDir} already read "${name}".`);
