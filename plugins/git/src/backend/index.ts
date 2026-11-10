import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackendPluginAPI } from '@brucede/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@brucede/plugin-api';
import type { GitChange, GitRepositoryService, GitStatus } from '../shared.js';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

/**
 * Backend half of the Git plugin.
 *
 * It shells out to the user's `git` binary in the backend process and publishes
 * the result as `git.repository`. Raw `child_process` access is allowed because
 * plugins run as trusted native code; the trust warning discloses exactly this.
 */
export function activate(api: BackendPluginAPI): void {
    const cwd = api.workspace.cwd;

    const service: GitRepositoryService = {
        status: () => readStatus(cwd)
    };

    api.services.provide(WORKSPACE_SERVICE_IDS.gitRepository, service);
}

/** Resolves repository root and change set in one round trip. */
async function readStatus(cwd: string): Promise<GitStatus> {
    const empty: GitStatus = { repository: false, ahead: 0, behind: 0, changes: [] };

    let root: string;
    try {
        const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: GIT_TIMEOUT_MS });
        root = stdout.trim();
    } catch (error) {
        // `git rev-parse` fails outside a work tree; that is a normal state, not a bug.
        return { ...empty, error: describeError(error) };
    }
    if (!root) {
        return empty;
    }

    try {
        const { stdout } = await run('git', ['status', '--porcelain=v2', '-z', '--branch'], {
            cwd: root,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024
        });
        return { repository: true, root, ...parsePorcelainV2(stdout) };
    } catch (error) {
        return { ...empty, root, error: describeError(error) };
    }
}

interface ParsedStatus {
    readonly branch?: string;
    readonly ahead: number;
    readonly behind: number;
    readonly changes: GitChange[];
}

/**
 * Parses `git status --porcelain=v2 -z --branch`.
 *
 * With `-z` every record is NUL-terminated, including the `# branch.*` headers.
 * Type `2` (rename/copy) records carry the original path as the *next* NUL
 * token, and paths may contain spaces, so records are split on a fixed number
 * of fields rather than with a plain `split(' ')` over the whole line.
 */
export function parsePorcelainV2(output: string): ParsedStatus {
    let branch: string | undefined;
    let ahead = 0;
    let behind = 0;
    const changes: GitChange[] = [];

    const tokens = output.split('\0');
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token) {
            continue;
        }

        if (token.startsWith('# branch.head ')) {
            const head = token.slice('# branch.head '.length);
            branch = head === '(detached)' ? undefined : head;
            continue;
        }
        if (token.startsWith('# branch.ab ')) {
            const match = /\+(\d+)\s+-(\d+)/.exec(token.slice('# branch.ab '.length));
            if (match) {
                ahead = Number(match[1]);
                behind = Number(match[2]);
            }
            continue;
        }
        if (token.startsWith('# ')) {
            continue;
        }

        const type = token[0];
        if (type === '?' ) {
            changes.push(untrackedEntry(token.slice(2)));
            continue;
        }
        if (type === '!' || type === 'u') {
            // Ignored entries are not changes; unmerged entries are surfaced as
            // conflicts through the plain '1'/'2' records they also produce.
            if (type === '!') {
                continue;
            }
            const fields = token.split(' ');
            const path = fields.slice(10).join(' ');
            if (path) {
                changes.push({ path, indexStatus: 'U', workTreeStatus: 'U', staged: false, untracked: false });
            }
            continue;
        }
        if (type !== '1' && type !== '2') {
            continue;
        }

        const fields = token.split(' ');
        const xy = fields[1] ?? '..';
        // Type 2 records append the original path as the next NUL token.
        if (type === '2') {
            index++;
        }
        const path = fields.slice(type === '2' ? 9 : 8).join(' ');
        if (!path) {
            continue;
        }
        changes.push({
            path,
            indexStatus: xy[0] ?? '.',
            workTreeStatus: xy[1] ?? '.',
            staged: (xy[0] ?? '.') !== '.' && (xy[0] ?? '.') !== '?',
            untracked: false
        });
    }

    changes.sort((left, right) => left.path.localeCompare(right.path));
    return { branch, ahead, behind, changes };
}

function untrackedEntry(path: string): GitChange {
    return { path, indexStatus: '?', workTreeStatus: '?', staged: false, untracked: true };
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        // `execFile` failures carry stderr, which is the useful part for git.
        const stderr = (error as { stderr?: string }).stderr;
        return stderr?.trim() || error.message;
    }
    return String(error);
}
