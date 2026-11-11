#!/usr/bin/env node
/**
 * Build Theia's ffmpeg inspector addon if npm did not.
 *
 * `theia build` for the Electron target calls `prepareElectron()`, which replaces
 * Electron's bundled `libffmpeg.so` and then *checks* it for proprietary codecs.
 * That check runs in plain Node and loads a native addon from
 * `@theia/ffmpeg/build/Release/ffmpeg.node` (falling back to `build/Debug`).
 *
 * npm builds that addon implicitly: a package that ships a `binding.gyp` with no
 * `install` script gets `node-gyp rebuild` at install time. Nothing in the
 * package's own metadata declares it, so the build is invisible and easy to lose:
 *
 *   - `npm install --ignore-scripts`, or an npm `allowScripts` policy that does not
 *     cover it, skips the implicit script entirely;
 *   - a package manager that restores `node_modules` from a binary cache can bring
 *     back the directory without its compiled output.
 *
 * Either way the failure is late and obscure: the install succeeds, and the build
 * dies with `Cannot find module '../build/Debug/ffmpeg.node'` after printing
 * harmless-looking ffmpeg cache messages.
 *
 * So the Electron build asks for the addon explicitly instead of relying on
 * install-time side effects. The addon is compiled with NAPI_VERSION=2 and
 * dlopen()s the shared library, so it has no external headers to find and works
 * for both the Node-side check and Electron itself.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(path.join(repoRoot, 'index.js'));

/** Both locations `_loadFfmpegNativeAddon()` accepts. */
const ADDON_PATHS = ['build/Release/ffmpeg.node', 'build/Debug/ffmpeg.node'];

function resolveFfmpegPackage() {
    try {
        return path.dirname(requireFromRoot.resolve('@theia/ffmpeg/package.json'));
    } catch {
        return undefined;
    }
}

function resolveNodeGyp() {
    const candidates = [
        'node-gyp/bin/node-gyp.js',
        'npm/node_modules/node-gyp/bin/node-gyp.js'
    ];
    for (const candidate of candidates) {
        try {
            return requireFromRoot.resolve(candidate);
        } catch {
            // Try the next candidate.
        }
    }
    return undefined;
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    return result.status === 0;
}

function main() {
    const ffmpegPackage = resolveFfmpegPackage();
    if (!ffmpegPackage) {
        console.error('[ffmpeg] @theia/ffmpeg is not installed; run "npm install" first.');
        return 1;
    }

    const present = ADDON_PATHS.map(relative => path.join(ffmpegPackage, relative))
        .find(absolute => existsSync(absolute));
    if (present) {
        // Rebuilding would cost a compiler invocation on every build.
        return 0;
    }

    const nodeGyp = resolveNodeGyp();
    if (!nodeGyp) {
        console.error('[ffmpeg] node-gyp is not installed, so the ffmpeg addon cannot be built.');
        console.error('[ffmpeg] Run "npm install", then run this build again.');
        return 1;
    }

    console.log('[ffmpeg] building the ffmpeg addon (npm did not build it at install time)');
    if (run(process.execPath, [nodeGyp, 'rebuild'], ffmpegPackage)) {
        return 0;
    }

    // node-gyp downloads Node headers, which needs network access. Linux
    // distributions that ship nodejs also ship its headers, so try those before
    // giving up — this is the common case on a freshly installed Arch machine.
    const systemHeaders = '/usr/include/node/node.h';
    if (existsSync(systemHeaders)) {
        console.log('[ffmpeg] retrying with the system Node headers');
        if (run(process.execPath, [nodeGyp, 'rebuild', '--nodedir=/usr'], ffmpegPackage)) {
            return 0;
        }
    }

    console.error('[ffmpeg] the ffmpeg addon could not be built.');
    console.error('[ffmpeg] Theia needs it to inspect Electron\'s ffmpeg library, which is');
    console.error('[ffmpeg] compiled from C with node-gyp: install python3, make and a C');
    console.error('[ffmpeg] compiler (build-essential / base-devel / Xcode CLT / MSVC Build Tools),');
    console.error('[ffmpeg] or allow install scripts so npm can build it: npm rebuild @theia/ffmpeg');
    return 1;
}

process.exitCode = main();
