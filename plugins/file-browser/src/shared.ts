/** Wire types shared by the file browser's renderer and backend halves. */

/** Absolute paths the browser may start from. */
export interface FileRoots {
    readonly cwd: string;
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
