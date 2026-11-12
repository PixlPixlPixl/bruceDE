#!/usr/bin/env node
/**
 * Bundles one Icebox plugin folder into the ESM entrypoints declared in its
 * `plugin.json`.
 *
 * Frontend bundles keep the shared host modules external as
 * `/icebox-host-modules/<file>.js` specifiers; the renderer rewrites those to
 * blob URLs backed by its own React/Lumino instances at load time. Backend
 * bundles are self-contained ESM for the normal Node backend.
 *
 * Usage: node build.mjs [pluginDir]
 */
import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_MODULE_PREFIX = '/icebox-host-modules';
const HOST_MODULES = {
    react: 'react.js',
    'react/jsx-runtime': 'react-jsx-runtime.js',
    'react/jsx-dev-runtime': 'react-jsx-dev-runtime.js',
    'react-dom': 'react-dom.js',
    'react-dom/client': 'react-dom-client.js',
    '@lumino/widgets': 'lumino-widgets.js',
    '@lumino/signaling': 'lumino-signaling.js',
    '@lumino/domutils': 'lumino-domutils.js',
    '@lumino/coreutils': 'lumino-coreutils.js',
    '@theia/core/lib/browser': 'theia-core-browser.js',
    '@theia/core/lib/common': 'theia-core-common.js',
    '@theia/core/lib/browser/widgets/react-widget': 'theia-react-widget.js',
    '@icebox/plugin-api': 'icebox-plugin-api.js'
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** Builds one plugin folder. Throws if the manifest is unreadable. */
export async function buildPlugin(pluginDir) {
    const resolvedDir = path.resolve(pluginDir);
    const manifestPath = path.join(resolvedDir, 'plugin.json');
    const manifest = await readManifest(manifestPath);
    const built = [];

    const frontendEntry = manifest.entrypoints?.frontend;
    if (frontendEntry && await hasAny(path.join(resolvedDir, 'src/frontend'), 'index')) {
        const source = await pickEntry(resolvedDir, 'src/frontend/index');
        await buildFrontend(source, path.join(resolvedDir, frontendEntry));
        built.push(frontendEntry);
    }

    const backendEntry = manifest.entrypoints?.backend;
    if (backendEntry && (await exists(path.join(resolvedDir, 'src/backend/index.ts')))) {
        await buildBackend(path.join(resolvedDir, 'src/backend/index.ts'), path.join(resolvedDir, backendEntry));
        built.push(backendEntry);
    }

    if (built.length === 0) {
        // Data-only plugins (`contributes.agents` and no entrypoints) are complete
        // without a build; anything else that declares an entrypoint but ships no
        // source is a mistake worth warning about.
        const declaresCode = Boolean(manifest.entrypoints?.frontend || manifest.entrypoints?.backend);
        if (declaresCode) {
            console.warn(`[plugin-build] ${manifest.id}: nothing to build (no src/frontend or src/backend entrypoint).`);
        }
    } else {
        console.log(`[plugin-build] ${manifest.id}: built ${built.join(', ')}`);
    }
    return built;
}

async function main() {
    await buildPlugin(process.argv[2] ?? process.cwd());
}

async function buildFrontend(entryPoint, outfile) {
    const alias = Object.fromEntries(
        Object.entries(HOST_MODULES).map(([bare, file]) => [bare, `${HOST_MODULE_PREFIX}/${file}`])
    );
    await esbuild.build({
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        // Classic JSX transform so every plugin file that renders JSX uses the
        // host React namespace it imports explicitly.
        jsx: 'transform',
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
        alias,
        external: [`${HOST_MODULE_PREFIX}/*`],
        sourcemap: true,
        logLevel: 'warning'
    });
}

async function buildBackend(entryPoint, outfile) {
    await esbuild.build({
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node18',
        // The backend runtime is normal Node: keep electron external, bundle
        // everything else so a user-installed plugin does not depend on the
        // app's node_modules layout.
        external: ['electron'],
        sourcemap: true,
        logLevel: 'warning'
    });
}

async function pickEntry(baseDir, stem) {
    for (const extension of ['.tsx', '.ts', '.mts', '.jsx', '.js', '.mjs']) {
        const candidate = path.join(baseDir, stem + extension);
        if (await exists(candidate)) {
            return candidate;
        }
    }
    throw new Error(`No entrypoint found for ${stem}`);
}

/** True when any supported source extension exists for `stem`. */
async function hasAny(baseDir, stem) {
    for (const extension of ['.tsx', '.ts', '.mts', '.jsx', '.js', '.mjs']) {
        if (await exists(path.join(baseDir, stem + extension))) {
            return true;
        }
    }
    return false;
}

async function exists(filePath) {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readManifest(manifestPath) {
    let raw;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch (error) {
        throw new Error(`Cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid JSON in ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const isDirectInvocation =
    process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
    main().catch(error => {
        console.error('[plugin-build]', error);
        process.exit(1);
    });
}

void scriptDir;
