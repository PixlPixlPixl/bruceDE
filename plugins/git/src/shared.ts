/** Wire types shared by the Git plugin's renderer and backend halves. */

/** One changed path, as reported by `git status --porcelain=v2`. */
export interface GitChange {
    readonly path: string;
    /** Index (staged) status letter, '.' when unmodified. */
    readonly indexStatus: string;
    /** Working-tree status letter, '.' when unmodified. */
    readonly workTreeStatus: string;
    /** True when the change is at least partly staged. */
    readonly staged: boolean;
    /** True for `?` (untracked) entries. */
    readonly untracked: boolean;
}

/** Snapshot of the repository the backend is running in. */
export interface GitStatus {
    readonly repository: boolean;
    readonly root?: string;
    readonly branch?: string;
    readonly ahead: number;
    readonly behind: number;
    readonly changes: readonly GitChange[];
    readonly error?: string;
}

/**
 * Provided by the backend half under `git.repository`.
 *
 * Ids come from `@brucede/plugin-api` (`WORKSPACE_SERVICE_IDS.gitRepository`),
 * so another plugin can consume this without importing the implementation.
 */
export interface GitRepositoryService {
    status(): GitStatus | Promise<GitStatus>;
}
