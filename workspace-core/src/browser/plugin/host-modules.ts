import * as reactNamespace from '@theia/core/shared/react';
import * as reactJsxRuntime from '@theia/core/shared/react/jsx-runtime';
import * as reactJsxDevRuntime from '@theia/core/shared/react/jsx-dev-runtime';
import * as reactDomNamespace from '@theia/core/shared/react-dom';
import * as reactDomClient from '@theia/core/shared/react-dom/client';
import * as luminoWidgets from '@theia/core/shared/@lumino/widgets';
import * as luminoSignaling from '@theia/core/shared/@lumino/signaling';
import * as luminoDomutils from '@theia/core/shared/@lumino/domutils';
import * as luminoCoreutils from '@theia/core/shared/@lumino/coreutils';
import * as theiaBrowser from '@theia/core/lib/browser';
import * as theiaCommon from '@theia/core/lib/common';
import * as theiaReactWidget from '@theia/core/lib/browser/widgets/react-widget';
import * as pluginApi from '@icebox/plugin-api';
import { HOST_MODULES, HOST_MODULE_PREFIX } from '../../common/plugin-host-protocol.js';

/** Namespace object of an imported host module. */
type HostModuleNamespace = Record<string, unknown>;

/**
 * The host's own module instances, keyed by the bare specifier plugin bundles
 * are built against.
 *
 * These are **static** imports on purpose. A plugin bundle's `import "react"` is
 * rewritten to a blob URL, and the blob re-exports one of these namespaces, so a
 * plugin widget is an `instanceof` the same `Widget` class the shell uses and
 * React hooks share one runtime. A dynamic `import(bareSpecifier)` cannot work
 * here: the renderer bundle is built ahead of time and the browser cannot resolve
 * a bare specifier at runtime.
 *
 * `@theia/core/shared/*` is used where it exists because those are exactly the
 * instances Theia's own widgets use (`@theia/core/shared/react` re-exports the
 * same `react` module).
 */
const HOST_MODULE_NAMESPACES: Readonly<Record<string, HostModuleNamespace>> = {
    'react': reactNamespace as HostModuleNamespace,
    'react/jsx-runtime': reactJsxRuntime as HostModuleNamespace,
    'react/jsx-dev-runtime': reactJsxDevRuntime as HostModuleNamespace,
    'react-dom': reactDomNamespace as HostModuleNamespace,
    'react-dom/client': reactDomClient as HostModuleNamespace,
    '@lumino/widgets': luminoWidgets as HostModuleNamespace,
    '@lumino/signaling': luminoSignaling as HostModuleNamespace,
    '@lumino/domutils': luminoDomutils as HostModuleNamespace,
    '@lumino/coreutils': luminoCoreutils as HostModuleNamespace,
    '@theia/core/lib/browser': theiaBrowser as HostModuleNamespace,
    '@theia/core/lib/common': theiaCommon as HostModuleNamespace,
    '@theia/core/lib/browser/widgets/react-widget': theiaReactWidget as HostModuleNamespace,
    '@icebox/plugin-api': pluginApi as HostModuleNamespace
};

/** Global store the generated shim modules read their namespace from. */
const NAMESPACE_GLOBAL = '__iceboxHostModules';

function namespaceStore(): Record<string, HostModuleNamespace> {
    // SAFETY: this module is the only writer of the private `__iceboxHostModules`
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
 * Plugin bundles are built with `/icebox-host-modules/<file>.js` as an external
 * specifier. At load time the frontend fetches the bundle text and rewrites each
 * of those specifiers to a `blob:` URL created here. Each blob re-exports the
 * live host module namespace.
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
            const namespace = HOST_MODULE_NAMESPACES[bareSpecifier];
            if (!namespace) {
                // Adding a specifier to HOST_MODULES without adding its static
                // import here is a host bug, and the plugin relying on it would
                // fail with an unresolvable specifier instead.
                // eslint-disable-next-line no-console
                console.error(
                    `[plugin-host] Host module "${bareSpecifier}" has no static import; see HOST_MODULE_NAMESPACES.`
                );
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

// The rewriter itself is framework-free so it can be exercised outside the
// browser; re-exported here because this module is its public home.
export { rewriteHostModuleSpecifiers } from '../../common/host-module-rewrite.js';
