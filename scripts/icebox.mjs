#!/usr/bin/env node
/**
 * One entry point for installing, updating, uninstalling and starting Icebox.
 *
 *   node scripts/icebox.mjs install [--force] [--target browser|electron|both|none]
 *   node scripts/icebox.mjs update  [--force] [--target …] [--no-pull]
 *   node scripts/icebox.mjs uninstall [--yes] [--purge-data]
 *   node scripts/icebox.mjs start browser|electron [-- theia start arguments]
 *   node scripts/icebox.mjs status
 *
 * Every step is skipped when it is already up to date: the install state lives
 * in `.icebox/install-state.json` and holds fingerprints of the lockfile, the
 * TypeScript workspaces and the plugin sources, plus one fingerprint per built
 * application target. Run any step with `--force` to bypass the checks.
 *
 * The shell wrappers at the repository root (`install.sh`, `update.sh`,
 * `uninstall.sh`, `start-browser.sh`, `start-electron.sh` and their `.cmd`
 * counterparts) only call this file, so POSIX shells and Windows cmd.exe use
 * exactly the same logic.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, '.icebox');
const STATE_FILE = path.join(STATE_DIR, 'install-state.json');
const USER_DATA_DIR = path.join(os.homedir(), '.icebox');
const IS_WINDOWS = process.platform === 'win32';

/** Directories whose contents are generated, never fingerprints or kept. */
const GENERATED_DIRS = ['node_modules', 'lib', 'dist', 'src-gen', '.browser_modules', '.git'];

/** Build outputs that must exist before a step may be considered done. */
const WORKSPACE_OUTPUTS = ['packages/plugin-api/lib', 'packages/plugin-runtime/lib', 'workspace-core/lib'];

/** Sources that make up the TypeScript workspace packages. */
const WORKSPACE_SOURCES = [
    'package.json',
    'package-lock.json',
    'workspace-core/src',
    'workspace-core/package.json',
    'workspace-core/tsconfig.json',
    'packages/plugin-api/src',
    'packages/plugin-api/package.json',
    'packages/plugin-api/tsconfig.json',
    'packages/plugin-runtime/src',
    'packages/plugin-runtime/package.json',
    'packages/plugin-runtime/tsconfig.json',
    'packages/ui-kit/src',
    'packages/ui-kit/package.json',
];

/** Sources of the built-in plugins and of the bundler that produces them. */
const PLUGIN_SOURCES = ['plugins', 'packages/plugin-build'];

const TARGETS = {
    browser: {
        app: 'browser-app',
        // Theia writes compiled extensions to lib/ and generated sources to src-gen/.
        outputs: ['browser-app/lib/frontend', 'browser-app/src-gen'],
        clean: ['browser-app/lib', 'browser-app/src-gen'],
    },
    electron: {
        app: 'electron-app',
        outputs: ['electron-app/lib/backend/electron-main.js', 'electron-app/src-gen'],
        clean: ['electron-app/lib', 'electron-app/src-gen'],
    },
};

// --------------------------------------------------------------------------- logging

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[39m` : text);
const dim = text => paint('2', text);
const green = text => paint('32', text);
const yellow = text => paint('33', text);
const red = text => paint('31', text);
const bold = text => paint('1', text);

function info(message) {
    console.log(`${paint('36', 'icebox')} ${message}`);
}
function detail(message) {
    console.log(`${dim('      ' + message)}`);
}
function step(message) {
    console.log(`\n${paint('36', '▸')} ${bold(message)}`);
}
function warn(message) {
    console.warn(`${yellow('warning')} ${message}`);
}

function fail(message, hint) {
    console.error(`\n${red('error')} ${message}`);
    if (hint) {
        console.error(`      ${hint}`);
    }
    process.exit(1);
}

// --------------------------------------------------------------------------- helpers

function exists(relativePath) {
    try {
        return fs.existsSync(path.join(ROOT, relativePath));
    } catch {
        return false;
    }
}

function remove(relativePath) {
    const target = path.join(ROOT, relativePath);
    if (!fs.existsSync(target)) {
        return false;
    }
    fs.rmSync(target, { recursive: true, force: true });
    detail(`removed ${relativePath}`);
    return true;
}

function sha256(parts) {
    const hash = crypto.createHash('sha256');
    for (const part of parts) {
        hash.update(String(part));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function walk(absolutePath, relativePath, entries) {
    let stats;
    try {
        stats = fs.statSync(absolutePath);
    } catch {
        return;
    }
    if (stats.isDirectory()) {
        if (GENERATED_DIRS.includes(path.basename(absolutePath))) {
            return;
        }
        for (const name of fs.readdirSync(absolutePath)) {
            walk(path.join(absolutePath, name), `${relativePath}/${name}`, entries);
        }
    } else if (stats.isFile()) {
        entries.push(`${relativePath}:${stats.size}:${Math.floor(stats.mtimeMs)}`);
    }
}

/** Content-and-mtime fingerprint of every file under the given paths. */
function fingerprint(relativePaths) {
    const entries = [];
    for (const relativePath of relativePaths) {
        walk(path.join(ROOT, relativePath), relativePath, entries);
    }
    entries.sort();
    return sha256(entries);
}

function readText(relativePath) {
    try {
        return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    } catch {
        return '';
    }
}

// --------------------------------------------------------------------------- state

function readState() {
    try {
        const parsed = JSON.parse(readText('.icebox/install-state.json'));
        return { version: 1, targets: {}, ...parsed };
    } catch {
        return { version: 1, targets: {} };
    }
}

function saveState(state) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// --------------------------------------------------------------------------- fingerprints

let cachedNpmVersion;
function npmVersion() {
    if (cachedNpmVersion === undefined) {
        const result = spawnSync('npm', ['--version'], { cwd: ROOT, encoding: 'utf8', shell: IS_WINDOWS });
        cachedNpmVersion = result.status === 0 ? result.stdout.trim() : 'missing';
    }
    return cachedNpmVersion;
}

/**
 * Dependency fingerprint: the lockfile plus the things a node_modules tree is
 * valid for (Node, npm, platform and architecture, because native modules are
 * rebuilt per platform).
 */
function depsFingerprint() {
    return sha256([
        readText('package-lock.json'),
        readText('package.json'),
        process.versions.node,
        npmVersion(),
        process.platform,
        process.arch,
    ]);
}

function workspaceFingerprint() {
    return fingerprint(WORKSPACE_SOURCES);
}

function pluginsFingerprint() {
    return fingerprint(PLUGIN_SOURCES);
}

function targetFingerprint(target) {
    return sha256([
        target,
        workspaceFingerprint(),
        pluginsFingerprint(),
        depsFingerprint(),
        readText(`${TARGETS[target].app}/package.json`),
        readText('package.json'),
    ]);
}

function outputsPresent(relativePaths) {
    return relativePaths.every(relativePath => exists(relativePath));
}

/** Every plugin folder that declares entrypoints must have its bundles built. */
function pluginsBuilt() {
    const pluginsRoot = path.join(ROOT, 'plugins');
    let manifests;
    try {
        manifests = fs.readdirSync(pluginsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    } catch {
        return false;
    }
    for (const entry of manifests) {
        const manifestPath = path.join(pluginsRoot, entry.name, 'plugin.json');
        if (!fs.existsSync(manifestPath)) {
            continue;
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch {
            return false;
        }
        const entrypoints = manifest.entrypoints ?? {};
        const bundles = Object.values(entrypoints).filter(value => typeof value === 'string' && value.length > 0);
        for (const bundle of bundles) {
            const bundlePath = path.resolve(path.dirname(manifestPath), bundle);
            if (!fs.existsSync(bundlePath)) {
                return false;
            }
        }
    }
    return true;
}

function appBuilt(target) {
    return outputsPresent(TARGETS[target].outputs);
}

// --------------------------------------------------------------------------- process execution

function childEnvironment() {
    // Never let npm's own "run me from a script" markers leak into a nested npm run.
    const env = { ...process.env };
    delete env.npm_config_prefix;
    return env;
}

/** Runs a command to completion, streaming its output. */
function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: ROOT,
            env: childEnvironment(),
            stdio: 'inherit',
            // Windows resolves `npm` only through cmd.exe; POSIX shells find it directly.
            shell: IS_WINDOWS,
        });
        child.on('error', error => reject(new Error(`Cannot run ${command}: ${error.message}`)));
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${command} was terminated by ${signal}`));
            } else if (code !== 0) {
                reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

async function npmRun(script, extraArgs = []) {
    const args = ['run', script];
    if (extraArgs.length > 0) {
        args.push('--', ...extraArgs);
    }
    await run('npm', args);
}

/** Runs a long-lived command, forwarding signals and its exit code. */
function runForeground(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: ROOT,
            env: childEnvironment(),
            stdio: 'inherit',
            shell: IS_WINDOWS,
        });
        const forward = signal => {
            try {
                child.kill(signal);
            } catch {
                // The child may already be gone; its exit handler decides the result.
            }
        };
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, forward);
        }
        child.on('error', error => reject(new Error(`Cannot run ${command}: ${error.message}`)));
        child.on('exit', (code, signal) => {
            for (const cleanupSignal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
                process.off(cleanupSignal, forward);
            }
            if (signal === 'SIGINT' || signal === 'SIGTERM') {
                resolve(130);
            } else {
                resolve(code ?? 0);
            }
        });
    });
}

// --------------------------------------------------------------------------- preflight

function preflight() {
    const engines = readText('package.json').match(/"node"\s*:\s*"[^"]*?(\d+)/);
    const minimum = engines ? Number(engines[1]) : 18;
    const current = Number(process.versions.node.split('.')[0]);
    if (current < minimum) {
        fail(
            `Icebox needs Node.js ${minimum} or newer, but this is ${process.versions.node}.`,
            'Install a current Node.js LTS from https://nodejs.org and run the script again.',
        );
    }
    if (npmVersion() === 'missing') {
        fail(
            'npm was not found on PATH.',
            'Install npm (it ships with Node.js) and run the script again.',
        );
    }
}

// --------------------------------------------------------------------------- install steps

async function ensureDependencies(state, options) {
    const fingerprintValue = depsFingerprint();
    const installed = exists('node_modules/@theia/cli');
    if (!options.force && installed && state.deps === fingerprintValue) {
        info('dependencies are up to date');
        return;
    }

    if (installed) {
        step('Updating dependencies');
        await run('npm', ['install', '--no-audit', '--no-fund']);
    } else {
        step('Installing dependencies');
        if (exists('package-lock.json')) {
            try {
                await run('npm', ['ci', '--no-audit', '--no-fund']);
            } catch (error) {
                warn(`${error.message} — falling back to npm install (the lockfile may be out of date).`);
                await run('npm', ['install', '--no-audit', '--no-fund']);
            }
        } else {
            await run('npm', ['install', '--no-audit', '--no-fund']);
        }
    }

    // Record the fingerprints of what the install actually produced. npm may
    // rewrite the lockfile, and the postinstall may have compiled the workspace
    // packages; recompute both so the next run can trust them.
    state.deps = depsFingerprint();
    if (outputsPresent(WORKSPACE_OUTPUTS)) {
        state.workspace = workspaceFingerprint();
    }
    saveState(state);
}

async function ensureWorkspace(state, options) {
    const fingerprintValue = workspaceFingerprint();
    if (!options.force && state.workspace === fingerprintValue && outputsPresent(WORKSPACE_OUTPUTS)) {
        info('local packages are up to date');
        return;
    }
    step('Building local packages (@icebox/plugin-api → @icebox/plugin-runtime → workspace-core)');
    await npmRun('build:workspace-core');
    state.workspace = fingerprintValue;
    saveState(state);
}

async function ensurePlugins(state, options) {
    const fingerprintValue = pluginsFingerprint();
    if (!options.force && state.plugins === fingerprintValue && pluginsBuilt()) {
        info('plugins are up to date');
        return;
    }
    step('Building plugin bundles');
    await npmRun('build:plugins');
    state.plugins = fingerprintValue;
    saveState(state);
}

async function ensureTarget(state, target, options) {
    const fingerprintValue = targetFingerprint(target);
    if (!options.force && state.targets[target] === fingerprintValue && appBuilt(target)) {
        info(`${target} application is up to date`);
        return;
    }
    step(`Building the ${target} application (first build takes several minutes)`);
    // Dependencies, workspace packages and plugins are already built above, so
    // only the application bundle itself is needed here.
    await run('npm', ['--prefix', TARGETS[target].app, 'run', 'bundle']);
    state.targets[target] = fingerprintValue;
    saveState(state);
}

async function install(options) {
    preflight();
    const state = readState();
    await ensureDependencies(state, options);
    await ensureWorkspace(state, options);
    await ensurePlugins(state, options);
    for (const target of options.targets) {
        await ensureTarget(state, target, options);
    }
    saveState(state);
    console.log('');
    info(`${green('Icebox is ready.')} Start it with ${bold('./start-browser.sh')}${options.targets.includes('electron') ? ` or ${bold('./start-electron.sh')}` : ''}.`);
}

// --------------------------------------------------------------------------- update

function pullLatest() {
    const gitAvailable = spawnSync('git', ['--version'], { cwd: ROOT, encoding: 'utf8', shell: IS_WINDOWS }).status === 0;
    if (!gitAvailable || !exists('.git')) {
        detail('not a git checkout — skipping git pull');
        return;
    }
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', shell: IS_WINDOWS });
    if (status.status !== 0) {
        warn('git status failed — skipping git pull');
        return;
    }
    if (status.stdout.trim().length > 0) {
        warn('uncommitted changes are present — skipping git pull, rebuilding the checkout as it is');
        return;
    }
    step('Pulling the latest source');
    const result = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, encoding: 'utf8', shell: IS_WINDOWS });
    if (result.status !== 0) {
        warn(`git pull did not apply:\n${(result.stderr || result.stdout).trim()}`);
        detail('continuing with the current checkout');
        return;
    }
    const summary = result.stdout.trim().split('\n').filter(Boolean).pop();
    detail(summary ?? 'already up to date');
}

async function update(options) {
    preflight();
    if (!options.noPull) {
        pullLatest();
    }
    const state = readState();
    await ensureDependencies(state, options);
    await ensureWorkspace(state, options);
    await ensurePlugins(state, options);
    // Rebuild only the targets that were already built; update never adds a
    // target the user has not started before. An explicit --target overrides
    // that, including --target none (rebuild no application).
    const builtTargets = options.explicitTarget
        ? options.targets
        : Object.keys(TARGETS).filter(target => appBuilt(target) || state.targets[target]);
    for (const target of builtTargets) {
        await ensureTarget(state, target, options);
    }
    saveState(state);
    console.log('');
    info(`${green('Icebox is up to date.')}`);
}

// --------------------------------------------------------------------------- uninstall

function generatedPaths() {
    const paths = [
        'node_modules',
        '.browser_modules',
        'dist',
        '.icebox',
        'packages/plugin-api/lib',
        'packages/plugin-runtime/lib',
        'workspace-core/lib',
        'workspace-core/src-gen',
        ...Object.values(TARGETS).flatMap(target => target.clean),
    ];
    const pluginsRoot = path.join(ROOT, 'plugins');
    try {
        for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && fs.existsSync(path.join(pluginsRoot, entry.name, 'plugin.json'))) {
                paths.push(`plugins/${entry.name}/dist`);
            }
        }
    } catch {
        // No plugins folder: nothing extra to remove.
    }
    return paths.filter((relativePath, index, all) => all.indexOf(relativePath) === index && exists(relativePath));
}

async function confirm(question) {
    if (!process.stdin.isTTY) {
        return false;
    }
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await terminal.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        terminal.close();
    }
}

async function uninstall(options) {
    const paths = generatedPaths();
    console.log(`${bold('Icebox uninstall')}`);
    detail(`repository: ${ROOT}`);
    if (paths.length === 0) {
        detail('nothing generated is present');
    } else {
        detail('removes:');
        for (const relativePath of paths) {
            console.log(`${dim(`        ${relativePath}`)}`);
        }
    }
    detail(`keeps your source checkout${options.purgeData ? '' : ` and user data (${USER_DATA_DIR})`}`);

    const approved = options.yes || await confirm('Remove the generated files?');
    if (!approved) {
        info('nothing was removed');
        return;
    }
    step('Removing generated files');
    for (const relativePath of paths) {
        remove(relativePath);
    }
    if (options.purgeData) {
        step('Removing user data');
        if (fs.existsSync(USER_DATA_DIR)) {
            fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
            detail(`removed ${USER_DATA_DIR}`);
        } else {
            detail(`nothing at ${USER_DATA_DIR}`);
        }
    }
    console.log('');
    info(`${green('Icebox is uninstalled.')} Reinstall with ${bold('./install.sh')}.`);
}

// --------------------------------------------------------------------------- start

async function start(target, args) {
    preflight();
    const state = readState();
    await ensureDependencies(state, {});
    await ensureWorkspace(state, {});
    await ensurePlugins(state, {});
    await ensureTarget(state, target, {});
    saveState(state);
    console.log('');
    info(`starting the ${target} application${args.length > 0 ? ` with ${args.join(' ')}` : ''}`);
    const exitCode = await runForeground('npm', ['run', `start:${target}`, '--', ...args]);
    process.exit(exitCode);
}

// --------------------------------------------------------------------------- status

function status() {
    const state = readState();
    const deps = depsFingerprint();
    const workspace = workspaceFingerprint();
    const plugins = pluginsFingerprint();
    const lines = [];
    const row = (label, value) => lines.push([label, value]);
    const tracked = (recorded, expected, present, staleText, missingText, untrackedText = 'built, not tracked (run ./install.sh)') => {
        if (!present) {
            return yellow(missingText);
        }
        if (recorded === undefined) {
            return yellow(untrackedText);
        }
        return recorded === expected ? green('up to date') : yellow(staleText);
    };

    row('node', process.versions.node);
    row('npm', npmVersion());
    row('platform', `${process.platform}-${process.arch}`);
    row(
        'dependencies',
        tracked(
            state.deps,
            deps,
            exists('node_modules/@theia/cli'),
            'outdated (run ./install.sh)',
            'not installed',
            'installed, not tracked (run ./install.sh)',
        ),
    );
    row(
        'local packages',
        tracked(
            state.workspace,
            workspace,
            outputsPresent(WORKSPACE_OUTPUTS),
            'outdated (run ./install.sh)',
            'not built',
        ),
    );
    row(
        'plugins',
        tracked(state.plugins, plugins, pluginsBuilt(), 'outdated (run ./install.sh)', 'not built'),
    );
    for (const target of Object.keys(TARGETS)) {
        row(
            `${target} app`,
            tracked(
                state.targets[target],
                targetFingerprint(target),
                appBuilt(target),
                'outdated (rebuilds on start)',
                target === 'browser' ? 'not built (install.sh builds it)' : 'not built (builds on start)',
            ),
        );
    }
    row('user data', fs.existsSync(USER_DATA_DIR) ? USER_DATA_DIR : dim(`${USER_DATA_DIR} (empty)`));
    row('state file', exists('.icebox/install-state.json') ? '.icebox/install-state.json' : dim('none'));

    const width = Math.max(...lines.map(([label]) => label.length));
    console.log(bold('Icebox status'));
    for (const [label, value] of lines) {
        console.log(`  ${label.padEnd(width)}  ${value}`);
    }
}

// --------------------------------------------------------------------------- CLI

function parseOptions(args) {
    const options = {
        force: false,
        yes: false,
        noPull: false,
        purgeData: false,
        targets: [],
        targetOption: 'browser',
        explicitTarget: false,
    };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        switch (argument) {
            case '--force':
            case '-f':
                options.force = true;
                break;
            case '--yes':
            case '-y':
                options.yes = true;
                break;
            case '--no-pull':
                options.noPull = true;
                break;
            case '--purge-data':
                options.purgeData = true;
                break;
            case '--target': {
                const value = args[++index];
                if (value === undefined) {
                    fail('--target needs a value: browser, electron, both or none');
                }
                options.targetOption = value;
                options.explicitTarget = true;
                break;
            }
            case '--':
                // Nothing after a bare `--` is an install option; stop parsing.
                index = args.length;
                break;
            default:
                if (argument.startsWith('--target=')) {
                    options.targetOption = argument.slice('--target='.length);
                    options.explicitTarget = true;
                } else if (argument.startsWith('-')) {
                    fail(`unknown option ${argument}`, 'Run ./install.sh --help for usage.');
                }
                break;
        }
    }
    return options;
}

function resolveTargets(option) {
    switch (option) {
        case 'browser':
            return ['browser'];
        case 'electron':
            return ['electron'];
        case 'both':
            return ['browser', 'electron'];
        case 'none':
            return [];
        default:
            fail(
                `unknown target ${option}`,
                'Use --target browser, --target electron, --target both or --target none.',
            );
    }
}

const HELP = `${bold('Icebox')} — install, update, uninstall and start

${bold('Usage')}
  ./install.sh        [--force] [--target browser|electron|both|none]
  ./update.sh         [--force] [--target …] [--no-pull]
  ./uninstall.sh      [--yes] [--purge-data]
  ./start-browser.sh  [theia start arguments]
  ./start-electron.sh [theia start arguments]
  ./status.sh

${bold('How it works')}
  Each script checks whether that step is already done for the current
  checkout and only runs npm and the builds when something changed.
  install.sh builds the browser target by default; start-electron.sh builds
  the electron target on first use. Use --force to rebuild unconditionally.

${bold('Targets')}
  browser    http://127.0.0.1:3000 by default; forwarded arguments reach
             \`theia start\` unchanged (for example --port 8080).
  electron   native desktop window; forwarded arguments reach \`theia start\`.

${bold('Uninstall')}
  Removes node_modules, the build outputs and the install state. The source
  checkout is kept, and ${USER_DATA_DIR} (installed plugins and layout state)
  is kept unless --purge-data is given.

${bold('Direct use')}
  node scripts/icebox.mjs <install|update|uninstall|start|status> [options]
`;

function startCommand() {
    const target = process.argv[3];
    if (target === undefined) {
        fail('start needs a target: browser or electron');
    }
    if (!Object.hasOwn(TARGETS, target)) {
        fail(`unknown start target ${target}`, 'Use browser or electron.');
    }
    // Everything after the target belongs to Theia, so `start` never sees
    // the install option parser.
    return start(target, process.argv.slice(4));
}

async function main() {
    const command = process.argv[2];
    const wantsHelp = process.argv.slice(2).some(argument => argument === '--help' || argument === '-h');

    if (wantsHelp) {
        console.log(HELP);
        return;
    }
    if (command === 'start') {
        await startCommand();
        return;
    }

    const options = parseOptions(process.argv.slice(3));

    switch (command) {
        case 'install':
            options.targets = resolveTargets(options.targetOption);
            await install(options);
            break;
        case 'update':
            options.targets = resolveTargets(options.targetOption);
            // update rebuilds the targets that already exist unless one was named.
            options.targets = options.explicitTarget ? options.targets : [];
            await update(options);
            break;
        case 'uninstall':
        case 'remove':
            await uninstall(options);
            break;
        case 'status':
            status();
            break;
        case 'help':
        case '--help':
        case '-h':
        case undefined:
            console.log(HELP);
            break;
        default:
            fail(`unknown command ${command}`, 'Run ./install.sh --help for usage.');
    }
}

main().catch(error => {
    fail(error instanceof Error ? error.message : String(error));
});
