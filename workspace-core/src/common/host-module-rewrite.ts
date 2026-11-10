/**
 * Rewrites the canonical host-module specifiers a plugin bundle was built with
 * to the blob URLs the renderer resolved.
 *
 * Kept in `common` and free of Theia imports on purpose: it is pure string
 * manipulation, so the runtime verification script can exercise it in plain Node
 * (the registry that produces the URLs needs `Blob`/`URL`, i.e. a browser or the
 * Theia bundle).
 */

export function rewriteHostModuleSpecifiers(
    source: string,
    rewriteMap: ReadonlyMap<string, string>
): string {
    let rewritten = source;
    for (const [canonical, blobUrl] of rewriteMap) {
        // Match the specifier as a whole string literal, in either quote style.
        const pattern = new RegExp(`(['"])${escapeRegExp(canonical)}\\1`, 'g');
        rewritten = rewritten.replace(pattern, `$1${blobUrl}$1`);
    }
    return rewritten;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
