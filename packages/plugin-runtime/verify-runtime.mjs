/**
 * Structural verification of the plugin runtime contract.
 *
 * Run after building: `node packages/plugin-runtime/verify-runtime.mjs`.
 * It exercises manifest validation, folder discovery, host-module specifier
 * rewriting, and Cordis activation/disposal without a DOM.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// Fail with an actionable message instead of a bare ERR_MODULE_NOT_FOUND: the
// local packages are compiled on install (root postinstall), so a checkout
// installed with --ignore-scripts lands here without any lib/ output.
const compiled = [
    'packages/plugin-api/lib/index.js',
    'packages/plugin-runtime/lib/index.js',
    'workspace-core/lib/node/plugin-discovery.js'
];
const missing = compiled.filter(relative => !fsSync.existsSync(path.join(root, relative)));
if (missing.length > 0) {
    console.error(`Cannot run verification: not built yet.\nMissing: ${missing.join(', ')}\nRun: npm run build:workspace-core`);
    process.exit(1);
}

const { validatePluginManifest, PluginManifestError, satisfiesVersion, CordisPluginManager } = await import(
    './lib/index.js'
);
const { discoverPlugins, normalizeRelativePath, toDescriptor } = await import(
    path.join(root, 'workspace-core/lib/node/plugin-discovery.js')
);
const { rewriteHostModuleSpecifiers } = await import(
    path.join(root, 'workspace-core/lib/common/host-module-rewrite.js')
);
const { PluginEventBus, PluginServiceRegistry } = await import(
    path.join(root, 'workspace-core/lib/common/plugin-registries.js')
);
const { HOST_PANEL_CAPABILITIES } = await import(
    path.join(root, 'packages/plugin-api/lib/index.js')
);
const { HOST_MODULES } = await import(
    path.join(root, 'workspace-core/lib/common/plugin-host-protocol.js')
);
const {
    HOST_PANEL_CAPABILITY_PATTERN,
    HostPanelFactoryRegistry
} = await import(
    path.join(root, 'workspace-core/lib/browser/host-panels/host-panel-factory-registry.js')
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

console.log('dependency resolution');
const fixtureRoot = await writeDependencyFixture();
const fixture = await discoverPlugins([fixtureRoot]);
check(
    'reports a dependency whose version range is unsatisfied',
    fixture.diagnostics.some(d => d.pluginId === 'bruce.needs-newer' && d.message.includes('^0.2.0')),
    fixture.diagnostics.map(d => d.message).join(' | ')
);
check(
    'accepts a dependency inside the declared range',
    !fixture.diagnostics.some(d => d.pluginId === 'bruce.uses-alpha' && d.message.includes('dependency')),
    fixture.diagnostics.map(d => d.message).join(' | ')
);
await fs.rm(path.dirname(fixtureRoot), { recursive: true, force: true });

console.log('shared services and events');
const services = new PluginServiceRegistry();
const bus = new PluginEventBus();
services.provide('bruce.alpha', 'alpha.api', { ping: () => 'pong' });
check('a service is resolvable by id', services.get('alpha.api').ping() === 'pong');
const received = [];
bus.on('bruce.beta', 'workspace/selection-changed', payload => received.push(payload));
bus.emit('workspace/selection-changed', 'file:///a.ts');
check('an event reaches a listener registered by another owner', received.length === 1);
services.removeByOwner('bruce.alpha');
bus.removeByOwner('bruce.beta');
check('unloading an owner removes its services', !services.has('alpha.api'));
bus.emit('workspace/selection-changed', 'file:///b.ts');
check('unloading an owner removes its listeners', received.length === 1);

console.log('host panel capabilities');
check(
    'the terminal capability is a stable id, not a class or module path',
    HOST_PANEL_CAPABILITIES.terminal === 'brucede.terminal',
    String(HOST_PANEL_CAPABILITIES.terminal)
);
check(
    'capability ids cannot look like module paths or class names',
    HOST_PANEL_CAPABILITY_PATTERN.test('brucede.terminal')
        && !HOST_PANEL_CAPABILITY_PATTERN.test('@theia/terminal')
        && !HOST_PANEL_CAPABILITY_PATTERN.test('TerminalWidget'),
    'the capability id pattern accepted a non-capability id'
);

console.log('plugin bundles stay inside the shared-module allowlist');
const hostModuleSpecifiers = Object.keys(HOST_MODULES).map(bare => `/brucede-host-modules/${HOST_MODULES[bare]}`);
for (const plugin of discovery.plugins) {
    const id = plugin.manifest.id;
    if (!plugin.frontendEntrypoint) {
        continue;
    }
    const source = await fs.readFile(plugin.frontendEntrypoint, 'utf8');
    const referenced = Array.from(new Set(source.match(/\/brucede-host-modules\/[A-Za-z0-9_-]+\.js/g) ?? []));
    const unknown = referenced.filter(specifier => !hostModuleSpecifiers.includes(specifier));
    check(`${id}: frontend imports only allowlisted host modules`, unknown.length === 0, unknown.join(', '));
}
const terminalPlugin = discovery.plugins.find(plugin => plugin.manifest.id === 'bruce.terminal');
const terminalSource = terminalPlugin?.frontendEntrypoint
    ? await fs.readFile(terminalPlugin.frontendEntrypoint, 'utf8')
    : '';
check(
    'terminal plugin does not embed Theia terminal internals',
    !term_source_has_theia(terminalSource),
    'xterm/@theia/terminal/TerminalWidget found in the plugin bundle'
);
check(
    'terminal plugin adopts the host capability instead of a widget factory',
    terminalSource.includes('/brucede-host-modules/brucede-plugin-api.js'),
    'host module specifier missing'
);

console.log('host panel factory registry');
const sampleWidget = { id: '', title: { label: '', caption: '' } };
const duplicateFirst = { id: '', title: { label: '', caption: '' } };
const duplicateSecond = { id: '', title: { label: '', caption: '' } };
const hostRegistry = new HostPanelFactoryRegistry({
    getContributions: () => [
        {
            capabilityId: 'brucede.terminal',
            label: 'Terminal',
            createPanel: () => sampleWidget
        },
        { capabilityId: '@theia/terminal', label: 'bad', createPanel: () => sampleWidget },
        {
            capabilityId: 'brucede.duplicate',
            label: 'first wins',
            createPanel: () => duplicateFirst
        },
        {
            capabilityId: 'brucede.duplicate',
            label: 'second ignored',
            createPanel: () => duplicateSecond
        }
    ]
});
check('collects a contributed capability', hostRegistry.has('brucede.terminal'));
check(
    'ignores a contributed id that looks like a module path',
    !hostRegistry.has('@theia/terminal'),
    hostRegistry.list().map(entry => entry.capabilityId).join(', ')
);
const duplicatePanel = await hostRegistry.create('brucede.duplicate', {
    capabilityId: 'brucede.duplicate',
    instanceId: 'instance-duplicate'
});
check('keeps the first factory for a duplicated capability', duplicatePanel === duplicateFirst);
const created = await hostRegistry.create('brucede.terminal', {
    capabilityId: 'brucede.terminal',
    instanceId: 'instance-1'
});
check('builds a panel through the capability', created === sampleWidget);
try {
    await hostRegistry.create('brucede.missing', { capabilityId: 'brucede.missing', instanceId: 'x' });
    check('reports an unknown capability instead of faking a panel', false);
} catch (error) {
    check('reports an unknown capability instead of faking a panel', String(error.message).includes('not available'));
}
try {
    hostRegistry.register({ capabilityId: 'brucede.other', label: 'x', createPanel: () => sampleWidget });
    check('late registration validates the id shape', true);
} catch (error) {
    check('late registration validates the id shape', false, error.message);
}
try {
    hostRegistry.register({ capabilityId: 'brucede/other', label: 'x', createPanel: () => sampleWidget });
    check('late registration refuses a path-like id', false);
} catch {
    check('late registration refuses a path-like id', true);
}

console.log('host capability wiring is host-owned');
const moduleSource = await readSource('workspace-core/src/browser/workspace-core-frontend-module.ts');
check(
    'the terminal capability is bound by the host extension, not by a plugin',
    moduleSource.includes('bind(HostPanelFactory).toService(TerminalHostPanelFactory)'),
    'binding missing from workspace-core frontend module'
);
const pluginSources = await collectPluginSources();
check(
    'no plugin registers, replaces or disposes a host panel factory',
    !pluginSources.some(source => source.includes('HostPanelFactory')),
    'plugin source references HostPanelFactory'
);
const terminalBundle = await readSource('plugins/terminal/dist/frontend.js');
check(
    'the terminal plugin only requests the capability',
    terminalBundle.includes('registerHostPanel') && !terminalBundle.includes('TerminalHostPanelFactory'),
    'terminal bundle builds its own factory'
);

console.log('plugin disable never destroys host-owned panels');
const dockingSource = await readSource('workspace-core/src/browser/workspace-docking-service.ts');
check(
    'closePanelsByOwner closes only plugin-owned instances',
    dockingSource.includes('getPluginOwnedInstancesByOwner'),
    'docking service closes host-capability panels'
);
const registrySource = await readSource('workspace-core/src/browser/workspace-panel-registry.ts');
check(
    'the panel registry marks host-capability panels',
    registrySource.includes('isHostPanelType') && registrySource.includes('hostPanel'),
    'hostPanel distinction missing from the panel registry'
);

console.log('plugin bundle delivery');
check(
    'manifest entrypoints are normalized for HTTP',
    normalizeRelativePath('./dist/frontend.js') === 'dist/frontend.js',
    normalizeRelativePath('./dist/frontend.js')
);
check(
    'served frontend URLs contain no "./" segment',
    discovery.plugins.every(plugin => {
        const url = toDescriptor(plugin).frontendUrl;
        return !url || !url.includes('/./');
    }),
    'a descriptor URL still carries "./"'
);
const protocolSource = await readSource('workspace-core/src/common/plugin-host-protocol.ts');
check(
    'the host can hand bundle text over the RPC channel',
    protocolSource.includes('readFrontendBundle'),
    'PluginHostClient.readFrontendBundle missing'
);
const managerSource = await readSource('workspace-core/src/browser/plugin/plugin-manager.ts');
check(
    'file:// renderers load bundles over RPC',
    managerSource.includes('readFrontendBundle'),
    'plugin manager never uses the RPC bundle path'
);
check(
    'same-origin renderers use the served URL',
    managerSource.includes('fetch(frontendUrl'),
    'plugin manager has no HTTP bundle path'
);
const hostModulesSource = await readSource('workspace-core/src/browser/plugin/host-modules.ts');
const missingNamespaces = Object.keys(HOST_MODULES).filter(
    bare => !hostModulesSource.includes(`'${bare}':`)
);
check(
    'every shared host module has a static namespace import',
    missingNamespaces.length === 0,
    missingNamespaces.join(', ')
);

console.log('renderer panels and app defaults');
const kernelSource = await readSource('workspace-core/src/browser/plugin/plugin-kernel.ts');
check(
    'a plugin panel renders once it is attached',
    /onAfterAttach[^]*this\.update\(\)/.test(kernelSource),
    'HostReactWidget never requests a render: panels attach as blank nodes'
);
const managerWidgetSource = await readSource('workspace-core/src/browser/plugin/plugin-manager-widget.ts');
check(
    'the plugin manager widget declares its shell id at construction time',
    /this\.id = PluginManagerWidget\.ID;/.test(managerWidgetSource)
        && !/onAfterAttach[^]*this\.id = /.test(managerWidgetSource),
    'a widget without an id is silently refused by ApplicationShell.addWidget'
);
const hostSources = await collectHostSources();
check(
    'the host ships no demo panels or demo commands',
    !hostSources.includes('bruce.demo.') && !hostSources.includes('WorkspaceDemoContribution'),
    'a demo contribution is still registered'
);
for (const app of ['electron-app', 'browser-app']) {
    const manifest = await readJsonSource(`${app}/package.json`);
    const config = manifest.theia?.frontend?.config ?? {};
    check(
        `${app} defaults to the dark theme`,
        config.defaultTheme === 'dark' && config.preferences?.['workbench.colorTheme'] === 'dark',
        `defaultTheme=${config.defaultTheme} preferences=${JSON.stringify(config.preferences)}`
    );
}

console.log('agent chat protocols');
const agentChatBackend = await readSource('plugins/agent-chat/src/backend/index.ts');
const agentChatShared = await readSource('plugins/agent-chat/src/shared.ts');
check(
    'the agent contract names both wire protocols',
    agentChatShared.includes("export type AgentProtocol = 'acp' | 'pi-rpc'")
        && agentChatShared.includes('readonly protocol: AgentProtocol'),
    'AgentDescriptor carries no protocol'
);
check(
    'Pi is offered through its own RPC mode',
    agentChatBackend.includes("protocol: 'pi-rpc'")
        && agentChatBackend.includes("'--mode', 'rpc'"),
    'Pi is not configured to run in RPC mode'
);
check(
    'every known agent declares a protocol',
    (agentChatBackend.match(/\{ id: '[^']+', name: '[^']+', protocol: '(acp|pi-rpc)'/g) ?? []).length >= 4,
    'a known agent is missing its protocol'
);
const piRpcSource = await readSource('plugins/agent-chat/src/pi-rpc.ts');
check(
    'the Pi RPC client implements handshake, prompt and abort',
    ['get_state', 'type: \'prompt\'', 'type: \'abort\''].every(token => piRpcSource.includes(token)),
    'the Pi client is missing a protocol command'
);
const spawnSource = await readSource('plugins/agent-chat/src/spawn.ts');
check(
    'agents are spawned without a generic shell on POSIX',
    spawnSource.includes('resolveExecutable') && !spawnSource.includes('shell: true'),
    'agent spawning relies on a generic shell layer'
);
check(
    'Windows npm shims are handled explicitly',
    /\.(cmd|bat)$/.test('pi.cmd') && /\.(cmd|bat)/.test(spawnSource) && spawnSource.includes('ComSpec'),
    'a .cmd agent shim would fail with ENOENT on Windows'
);
check(
    'both protocols share one session bookkeeping path',
    agentChatBackend.includes('interface AgentLink') && agentChatBackend.includes('ensureStarted'),
    'the session logic is duplicated per protocol'
);

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

/**
 * Writes three plugins into a temporary folder: one provider at `0.1.0`, one
 * consumer inside its range, and one consumer whose range cannot be satisfied.
 */
async function writeDependencyFixture() {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brucede-verify-'));
    const pluginsRoot = path.join(base, 'plugins');
    const writePlugin = async (folder, manifest) => {
        const directory = path.join(pluginsRoot, folder);
        await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
        await fs.writeFile(path.join(directory, 'dist', 'frontend.js'), 'export const boot = 1;\n');
        await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest, undefined, 2));
    };
    const common = {
        name: 'Fixture',
        version: '0.1.0',
        apiVersion: 1,
        entrypoints: { frontend: './dist/frontend.js' }
    };
    await writePlugin('alpha', { ...common, id: 'bruce.alpha' });
    await writePlugin('uses-alpha', {
        ...common,
        id: 'bruce.uses-alpha',
        dependencies: { 'bruce.alpha': '^0.1.0' }
    });
    await writePlugin('needs-newer', {
        ...common,
        id: 'bruce.needs-newer',
        dependencies: { 'bruce.alpha': '^0.2.0' }
    });
    return pluginsRoot;
}

/**
 * Reads a repo-relative file. Used only for structural invariants that cannot be
 * expressed by importing the browser modules (they need a DOM).
 */
async function readJsonSource(relativePath) {
    try {
        return JSON.parse(await readSource(relativePath));
    } catch (error) {
        check(`${relativePath} is valid JSON`, false, String(error));
        return {};
    }
}

/** Concatenates workspace-core's TypeScript sources so host-wide rules can be asserted. */
async function collectHostSources() {
    const chunks = [];
    async function walk(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
                chunks.push(await fs.readFile(full, 'utf8'));
            }
        }
    }
    await walk(path.join(root, 'workspace-core/src'));
    return chunks.join('\n');
}

async function readSource(relativePath) {
    return fs.readFile(path.join(root, relativePath), 'utf8');
}

/** Concatenates every plugin source file so plugin-wide rules can be asserted. */
async function collectPluginSources() {
    const directories = await fs.readdir(path.join(root, 'plugins'), { withFileTypes: true });
    const sources = [];
    for (const entry of directories) {
        if (entry.isDirectory()) {
            sources.push(await readTree(path.join(root, 'plugins', entry.name, 'src')));
        }
    }
    return sources;
}

async function readTree(directory) {
    let collected = '';
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return collected;
    }
    for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collected += await readTree(child);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            collected += await fs.readFile(child, 'utf8');
        }
    }
    return collected;
}

/** True when a plugin bundle embeds Theia/xterm internals. */
function term_source_has_theia(source) {
    return ['xterm', '@theia/terminal', 'TerminalWidget'].some(token => source.includes(token));
}