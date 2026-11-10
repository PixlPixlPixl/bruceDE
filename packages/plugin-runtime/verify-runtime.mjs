/**
 * Structural verification of the plugin runtime contract.
 *
 * Run after building: `node packages/plugin-runtime/verify-runtime.mjs`.
 * It exercises manifest validation, folder discovery, host-module specifier
 * rewriting, and Cordis activation/disposal without a DOM.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const { validatePluginManifest, PluginManifestError, satisfiesVersion, CordisPluginManager } = await import(
    './lib/index.js'
);
const { discoverPlugins } = await import(path.join(root, 'workspace-core/lib/node/plugin-discovery.js'));
const { rewriteHostModuleSpecifiers } = await import(
    path.join(root, 'workspace-core/lib/browser/plugin/host-modules.js')
);

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log('manifest validation');
const validManifest = validatePluginManifest({
    id: 'bruce.sample',
    name: 'Sample',
    version: '1.2.3',
    apiVersion: 1,
    entrypoints: { frontend: './dist/frontend.js' },
    contributes: { panels: [{ id: 'main', title: 'Main' }] }
});
check('accepts a valid manifest', validManifest.id === 'bruce.sample');
check('rejects an unsupported apiVersion', throwsManifest({ ...validManifest, apiVersion: 99 }));
check('rejects a non-namespaced id', throwsManifest({ ...validManifest, id: 'Sample' }));
check('rejects an escaping entrypoint', throwsManifest({ ...validManifest, entrypoints: { frontend: '../evil.js' } }));
check('rejects a manifest without entrypoints', throwsManifest({ ...validManifest, entrypoints: {} }));
check('version range ^1.2.0 matches 1.2.3', satisfiesVersion('1.2.3', '^1.2.0'));
check('version range ^2.0.0 rejects 1.2.3', !satisfiesVersion('1.2.3', '^2.0.0'));

console.log('folder discovery');
const discovery = await discoverPlugins([path.join(root, 'plugins')]);
const ids = discovery.plugins.map(plugin => plugin.manifest.id).sort();
check(
    'discovers the four built-in plugins',
    ['bruce.agent-chat', 'bruce.file-browser', 'bruce.git', 'bruce.terminal'].every(id => ids.includes(id)),
    ids.join(', ')
);
check('resolves frontend bundles', discovery.plugins.every(plugin => plugin.frontendEntrypoint));
check('bruce.workspace is not reported as missing', discovery.diagnostics.every(d => !d.message.includes('bruce.workspace')));

console.log('host module rewriting');
const blobMap = new Map([['/brucede-host-modules/react.js', 'blob:react']]);
const rewritten = rewriteHostModuleSpecifiers(
    'import React from "/brucede-host-modules/react.js";',
    blobMap
);
check('rewrites canonical specifier to blob URL', rewritten.includes('blob:react'));

console.log('Cordis activation and disposal');
const manager = new CordisPluginManager({ onError: () => undefined });
const events = [];
const api = {
    onActivate: () => events.push('activate'),
    onDispose: () => events.push('dispose')
};
const record = await manager.load({
    manifest: validManifest,
    loadModule: async () => ({
        activate(runtimeApi) {
            runtimeApi.onActivate();
            return () => runtimeApi.onDispose();
        }
    }),
    createApi: () => api
});
check('plugin reaches active state', record.state === 'active', record.state);
check('activate ran', events.includes('activate'));
await manager.unload('bruce.sample');
check('disposer ran on unload', events.includes('dispose'));
check('plugin is no longer active', !manager.isActive('bruce.sample'));

const failed = await manager.load({
    manifest: { ...validManifest, id: 'bruce.failing' },
    loadModule: async () => {
        throw new Error('import boom');
    },
    createApi: () => api
});
check('import failure is reported as failed', failed.state === 'failed');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

function throwsManifest(candidate) {
    try {
        validatePluginManifest(candidate);
        return false;
    } catch (error) {
        return error instanceof PluginManifestError;
    }
}
