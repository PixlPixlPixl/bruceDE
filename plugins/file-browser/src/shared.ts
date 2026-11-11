/** Wire types shared by the file browser's renderer and backend halves. */

/** Where the browser starts and where the application runs. */
export interface FileRoots {
    /** Working directory of the backend process (where the app was launched). */
    readonly cwd: string;
    /** Starting directory for the browser: the user's home folder. */
    readonly roots: readonly string[];
}

/**
 * Provided by the backend half so the renderer can learn the process working
 * directory. `FrontendPluginAPI` deliberately has no `workspace` field, and the
 * renderer has no other way to learn an absolute starting path.
 */
export interface FileRootsService {
    roots(): FileRoots | Promise<FileRoots>;
}

/** Service id of {@link FileRootsService}. */
export const FILE_ROOTS_SERVICE = 'files.roots';
