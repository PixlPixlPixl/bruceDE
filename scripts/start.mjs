#!/usr/bin/env node
/**
 * Launches the Theia app targets (`npm run start:browser`, `npm run start:electron`).
 *
 * Theia's own `start` command only knows `--hostname` (alias `-h`) and `--port`
 * (alias `-p`), while people reach for `--host` when they want to bind a
 * different interface. This launcher accepts `--host` and maps it to Theia's
 * `--hostname`, validates both values, and forwards every other argument
 * untouched — so `npm run start:browser -- --host 0.0.0.0 --port 8080` works
 * without learning Theia's naming.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
    browser: 'browser-app',
    electron: 'electron-app'
};

/** Arguments this launcher interprets; everything else is forwarded verbatim. */
const HOST_FLAGS = new Set(['--host', '--hostname', '-h']);
const PORT_FLAGS = new Set(['--port', '-p']);
const THEIA_ENTRYPOINT = path.join(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');

function fail(message) {
    console.error(`[bruce] ${message}`);
    process.exit(2);
}

/**
 * Reads the value of a flag, either inline (`--host=0.0.0.0`) or as the next
 * argument, and reports how many arguments it consumed.
 */
function readValue(argv, index, flag, inlineValue) {
    if (inlineValue !== undefined) {
        return { value: inlineValue, consumed: 0 };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) {
        fail(`${flag} needs a value`);
    }
    return { value: next, consumed: 1 };
}

function parseArguments(argv) {
    const target = argv[0];
    if (!target || !(target in TARGETS)) {
        fail(`usage: node scripts/start.mjs <${Object.keys(TARGETS).join('|')}> [--host <host>] [--port <port>] [-- theia options]`);
    }

    let host;
    let port;
    const forwarded = [];

    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        const [flag, inlineValue] = argument.includes('=')
            ? argument.split(/=(.*)/s)
            : [argument, undefined];

        if (HOST_FLAGS.has(flag)) {
            const { value, consumed } = readValue(argv, index, flag, inlineValue);
            index += consumed;
            host = value;
            continue;
        }
        if (PORT_FLAGS.has(flag)) {
            const { value, consumed } = readValue(argv, index, flag, inlineValue);
            index += consumed;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
                fail(`--port needs an integer between 1 and 65535, got "${value}"`);
            }
            port = parsed;
            continue;
        }
        forwarded.push(argument);
    }

    if (host !== undefined) {
        const trimmed = host.trim();
        if (!trimmed || /\s/.test(trimmed)) {
            fail(`--host needs a host name or address without spaces, got "${host}"`);
        }
        host = trimmed;
    }

    return { target, host, port, forwarded };
}

const { target, host, port, forwarded } = parseArguments(process.argv.slice(2));
const appDirectory = path.join(root, TARGETS[target]);

if (!existsSync(THEIA_ENTRYPOINT)) {
    fail(`cannot find ${path.relative(root, THEIA_ENTRYPOINT)} — run npm install first`);
}

// Theia reads `src-gen/backend/main.js` relative to its working directory, which
// is why the app folder has to be the cwd rather than the repository root.
const csArgs = [THEIA_ENTRYPOINT, 'start', ...forwarded];
if (host !== undefined) {
    csArgs.push('--hostname', host);
}
if (port !== undefined) {
    csArgs.push('--port', String(port));
}

if (target === 'browser') {
    const shownHost = host ?? 'localhost';
    const shownPort = port ?? 3000;
    console.log(`[bruce] starting the browser target on http://${shownHost}:${shownPort}`);
}

const child = spawn(process.execPath, csArgs, { cwd: appDirectory, stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        child.kill(signal);
    });
}

child.on('error', error => {
    console.error(`[bruce] failed to start the ${target} target: ${error.message}`);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : code ?? 0);
});
