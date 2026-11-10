import { HOST_MODULES, HOST_MODULE_PREFIX } from '../../common/plugin-host-protocol.js';

/** Namespace object of an imported host module. */
type HostModuleNamespace = Record<string, unknown>;

/** Global store the generated shim modules read their namespace from. */
const NAMESPACE_GLOBAL = '__brucedeHostModules';

function namespaceStore(): Record<string, HostModuleNamespace> {
    // SAFETY: this module is the only writer of the private `__brucedeHostModules`
    // global. The value is created as a string-keyed map of imported module
    // namespaces by this file, so the cast narrows `globalThis` without changing
    // the runtime value.
    const target = globalThis as unknown as Record<string, Record<string, HostModuleNamespace> | undefined>;
    let store = target[NAMESPACE_GLOBAL];
    if (!store) {
        store = {};
        target[NAMESPACE_GLOBAL] = store;
    }
    return store;
}

/**
 * Supplies plugin bundles with the *host's own* copies of shared modules.
 *
 * Plugin bundles are built with `/brucede-host-modules/<file>.js` as an external
 * specifier. At load time the frontend fetches the bundle text and rewrites each
 * of those specifiers to a `blob:` URL created here. Each blob re-exports the
 * live host module namespace, so a plugin widget is an `instanceof` the same
 * `Widget` class the shell uses and React hooks come from the host's React.
 *
 * This avoids bundling duplicate copies of React/Lumino and avoids requiring an
 * import map in the generated HTML (which Theia regenerates on every build).
 */
export class HostModuleRegistry {
    private readonly blobUrls = new Map<string, string>();
    private namespaceCount = 0;
    private initialization: Promise<void> | undefined;

    /** Canonical specifier → blob URL. */
    getBlobUrl(canonicalSpecifier: string): string | undefined {
        return this.blobUrls.get(canonicalSpecifier);
    }

    /** All canonical specifier → blob URL pairs, for rewriting bundle text. */
    getRewriteMap(): ReadonlyMap<string, string> {
        return this.blobUrls;
    }

    async initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = this.createShims();
        }
        return this.initialization;
    }

    private async createShims(): Promise<void> {
        for (const [bareSpecifier, fileName] of Object.entries(HOST_MODULES)) {
            const canonical = `${HOST_MODULE_PREFIX}/${fileName}`;
            if (this.blobUrls.has(canonical)) {
                continue;
            }
            let namespace: HostModuleNamespace;
            try {
                namespace = (await import(/* @vite-ignore */ bareSpecifier)) as HostModuleNamespace;
            } catch (error) {
                // eslint-disable-next-line no-console
                console.warn(`[plugin-host] Host module "${bareSpecifier}" is unavailable:`, error);
                continue;
            }
            this.blobUrls.set(canonical, this.createShimUrl(namespace));
        }
    }

    /** Generates an ES module that re-exports a host module's live namespace. */
    private createShimUrl(namespace: HostModuleNamespace): string {
        const id = `host-module-${this.namespaceCount++}`;
        namespaceStore()[id] = namespace;

        const lines = [`const __ns = globalThis.${NAMESPACE_GLOBAL}[${JSON.stringify(id)}];`];
        for (const key of Object.keys(namespace)) {
            if (key === 'default' || key === '__esModule' || !/^[A-Za-z_$][\w$]*$/.test(key)) {
                continue;
            }
            lines.push(`export const ${key} = __ns[${JSON.stringify(key)}];`);
        }
        if (namespace.default !== undefined) {
            lines.push('export default __ns.default;');
        }
        return URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/javascript' }));
    }

    dispose(): void {
        for (const url of this.blobUrls.values()) {
            URL.revokeObjectURL(url);
        }
        this.blobUrls.clear();
    }
}

/**
 * Rewrites the canonical host-module specifiers a plugin bundle was built with
 * to the blob URLs resolved in the renderer.
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
