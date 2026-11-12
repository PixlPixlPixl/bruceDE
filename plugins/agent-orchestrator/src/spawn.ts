import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/**
 * Resolving and spawning the agent CLIs.
 *
 * A bare `spawn('gemini', …)` is not enough in a desktop app: agent CLIs are
 * usually npm shims, which on Windows are `.cmd` files that `CreateProcess`
 * cannot execute directly. Resolving to a real path first makes the difference
 * between "the agent list shows an entry" and "the agent actually starts".
 */

const WINDOWS_EXTENSIONS = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(extension => extension.trim().toLowerCase())
    .filter(Boolean);

const IS_WINDOWS = process.platform === 'win32';

/** True when `command` resolves to an executable file. */
export function executableExists(command: string): boolean {
    return resolveExecutable(command) !== undefined;
}

/**
 * Absolute path of `command`, or undefined.
 *
 * Absolute and separator-bearing paths are checked as given; bare names are
 * searched on `PATH`, trying `PATHEXT` suffixes on Windows (where the shim is
 * `pi.cmd`, not `pi`).
 */
export function resolveExecutable(command: string): string | undefined {
    const trimmed = command.trim();
    if (!trimmed) {
        return undefined;
    }
    const candidates = new Set<string>();
    const withExtensions = (base: string): string[] => {
        const extension = extname(base).toLowerCase();
        if (extension && (!IS_WINDOWS || WINDOWS_EXTENSIONS.includes(extension))) {
            return [base];
        }
        return IS_WINDOWS ? WINDOWS_EXTENSIONS.map(suffix => base + suffix) : [base];
    };

    if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
        for (const candidate of withExtensions(trimmed)) {
            candidates.add(candidate);
        }
    } else {
        for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
            for (const candidate of withExtensions(join(directory, trimmed))) {
                candidates.add(candidate);
            }
        }
    }

    for (const candidate of candidates) {
        try {
            if (!statSync(candidate).isFile()) {
                continue;
            }
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Keep probing the remaining candidates.
        }
    }
    return undefined;
}

/** Quotes one argument for a `cmd.exe` command line. */
function quoteForCmd(value: string): string {
    if (value.length > 0 && !/[\s"&|<>^()]/.test(value)) {
        return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Starts an agent process with piped stdio.
 *
 * Windows `.cmd`/`.bat` shims are scripts, not executables, so they cannot be
 * passed to `CreateProcess`. Those go through the command processor explicitly —
 * `cmd.exe` with our own quoted command line — instead of Node's generic shell option,
 * so the parsing is the same on every Node version and the argv is built here
 * rather than by a generic shell layer. Every other agent starts directly, with
 * no shell involved at all.
 */
export function spawnAgent(
    command: string,
    args: readonly string[],
    cwd: string
): ChildProcessWithoutNullStreams {
    const resolved = resolveExecutable(command) ?? command;
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved)) {
        const commandLine = [resolved, ...args].map(quoteForCmd).join(' ');
        const comspec = process.env.ComSpec || 'cmd.exe';
        return spawn(comspec, ['/d', '/s', '/c', commandLine], {
            cwd,
            windowsHide: true
        }) as ChildProcessWithoutNullStreams;
    }
    return spawn(resolved, [...args], { cwd, windowsHide: true }) as ChildProcessWithoutNullStreams;
}
