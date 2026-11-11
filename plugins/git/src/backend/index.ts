import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackendPluginAPI } from '@icebox/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@icebox/plugin-api';
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
        const parsed = parsePorcelainV2(stdout);
        const counts = await readLineCounts(root);
        return {
            repository: true,
            root,
            ...parsed,
            changes: parsed.changes.map(change => {
                const count = counts.get(change.path);
                return count ? { ...change, ...count } : change;
            })
        };
    } catch (error) {
        return { ...empty, root, error: describeError(error) };
    }
}

interface LineCounts {
    readonly added: number;
    readonly deleted: number;
}

/**
 * Lines changed per path, against `HEAD`.
 *
 * `git diff HEAD` covers staged *and* unstaged edits in one call, so the number
 * matches the file as the user sees it rather than one side of the index. A
 * repository without commits has no `HEAD`, and there the two halves are summed
 * instead.
 */
async function readLineCounts(root: string): Promise<Map<string, LineCounts>> {
    const counts = new Map<string, LineCounts>();
    const collect = async (args: readonly string[]): Promise<boolean> => {
        try {
            const { stdout } = await run('git', [...args], {
                cwd: root,
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024
            });
            parseNumstat(stdout, counts);
            return true;
        } catch {
            // No HEAD yet, or the diff failed; the panel simply shows no counts.
            return false;
        }
    };
    if (await collect(['diff', 'HEAD', '--numstat', '-z'])) {
        return counts;
    }
    await collect(['diff', '--numstat', '-z']);
    await collect(['diff', '--cached', '--numstat', '-z']);
    return counts;
}

/**
 * Parses `git diff --numstat -z`.
 *
 * Each record is `added<TAB>deleted<TAB>path`, NUL-terminated. With `-z` a
 * rename or copy carries an *empty* path and the old and new path as two more
 * NUL tokens, so the record itself is the only place the counts live — the new
 * path is the one `git status` reports, so that is the key used here. Binary
 * files report `-` instead of numbers and are skipped.
 */
export function parseNumstat(output: string, into: Map<string, LineCounts> = new Map()): Map<string, LineCounts> {
    const tokens = output.split('\0');
    const add = (path: string, added: number, deleted: number): void => {
        if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
            return;
        }
        const existing = into.get(path);
        into.set(path, existing
            ? { added: existing.added + added, deleted: existing.deleted + deleted }
            : { added, deleted });
    };

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token) {
            continue;
        }
        const firstTab = token.indexOf('\t');
        const secondTab = token.indexOf('\t', firstTab + 1);
        if (firstTab === -1 || secondTab === -1) {
            continue;
        }
        const added = Number.parseInt(token.slice(0, firstTab), 10);
        const deleted = Number.parseInt(token.slice(firstTab + 1, secondTab), 10);
        const path = token.slice(secondTab + 1);
        if (path) {
            add(path, added, deleted);
            continue;
        }
        // Rename/copy: the counts record has no path of its own.
        const original = tokens[index + 1];
        const renamed = tokens[index + 2];
        index += 2;
        add(renamed ?? original ?? '', added, deleted);
    }
    return into;
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
