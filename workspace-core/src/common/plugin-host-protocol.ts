/**
 * Contract shared by the BruceDE renderer and backend for plugin discovery,
 * trust decisions and asset delivery.
 *
 * This module must stay free of Theia, Lumino and Node imports: it is loaded by
 * both sides of the RPC boundary.
 */

/** RPC path the frontend proxy talks to. */
export const PLUGIN_HOST_PATH = '/services/bruce/plugin-host';

/** RPC path of the renderer → backend plugin service bridge. */
export const PLUGIN_SERVICE_RPC_PATH = '/services/bruce/plugin-services';

/** URL prefix under which the backend serves plugin ESM bundles and assets. */
export const PLUGIN_ASSET_PREFIX = '/brucede-plugin-assets';

/** URL prefix of the host-module shims a plugin bundle imports at runtime. */
export const HOST_MODULE_PREFIX = '/brucede-host-modules';

/**
 * Host modules a plugin bundle may import. The keys are the bare npm specifiers
 * plugin source imports; the values are the canonical shim file names emitted
 * by `@brucede/plugin-build` and resolved to host instances at load time.
 */
export const HOST_MODULES: Readonly<Record<string, string>> = Object.freeze({
    react: 'react.js',
    'react/jsx-runtime': 'react-jsx-runtime.js',
    'react/jsx-dev-runtime': 'react-jsx-dev-runtime.js',
    'react-dom': 'react-dom.js',
    'react-dom/client': 'react-dom-client.js',
    '@lumino/widgets': 'lumino-widgets.js',
    '@lumino/signaling': 'lumino-signaling.js',
    '@lumino/domutils': 'lumino-domutils.js',
    '@lumino/coreutils': 'lumino-coreutils.js',
    '@theia/core/lib/browser': 'theia-core-browser.js',
    '@theia/core/lib/common': 'theia-core-common.js',
    '@theia/core/lib/browser/widgets/react-widget': 'theia-react-widget.js',
    '@brucede/plugin-api': 'brucede-plugin-api.js'
});

/** Canonical specifier a plugin bundle uses to import a host module. */
export function hostModuleSpecifier(specifier: string): string {
    const file = HOST_MODULES[specifier];
    if (!file) {
        throw new Error(
            `"${specifier}" is not a shared host module. Add it to HOST_MODULES in @brucede/plugin-host-protocol.`
        );
    }
    return `${HOST_MODULE_PREFIX}/${file}`;
}

/** Reverse lookup: canonical specifier → bare npm specifier, if known. */
export function resolveHostModule(canonical: string): string | undefined {
    const prefix = `${HOST_MODULE_PREFIX}/`;
    if (!canonical.startsWith(prefix)) {
        return undefined;
    }
    const file = canonical.slice(prefix.length);
    return Object.keys(HOST_MODULES).find(key => HOST_MODULES[key] === file);
}

export interface PluginContributionSummary {
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
}

/**
 * A discovered plugin, as described to the renderer. Entrypoints are absolute
 * URL paths that the frontend can `fetch`/`import`; nothing here exposes a
 * filesystem path to the renderer.
 */
export interface PluginDescriptor {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly apiVersion: number;
    readonly description?: string;
    /** True for plugins shipped inside the BruceDE installation. */
    readonly builtIn: boolean;
    /** Folder the plugin was discovered in; diagnostic only. */
    readonly directory: string;
    /** URL path of the frontend ESM bundle, when the plugin declares one. */
    readonly frontendUrl?: string;
    /** Absolute path of the backend ESM bundle, when the plugin declares one. */
    readonly backendEntrypoint?: string;
    readonly dependencyIds: readonly string[];
    readonly panels: readonly PluginContributionSummary[];
    readonly commands: readonly PluginContributionSummary[];
    readonly services: readonly string[];
}

/** Why a plugin could not be accepted by the host. */
export interface PluginDiagnostic {
    readonly pluginId?: string;
    readonly directory: string;
    readonly message: string;
}

export interface PluginHostSnapshot {
    readonly plugins: readonly PluginDescriptor[];
    /** Ids the user explicitly accepted the full-system-access warning for. */
    readonly trusted: readonly string[];
    /** Ids the user enabled. Built-in plugins start enabled. */
    readonly enabled: readonly string[];
    readonly diagnostics: readonly PluginDiagnostic[];
}

/**
 * Frontend → backend plugin host API.
 *
 * Every mutation returns a fresh snapshot so the renderer never has to guess
 * what the authoritative state is after a trust/enable change.
 */
export interface PluginHostClient {
    getSnapshot(): Promise<PluginHostSnapshot>;
    /** Re-scans the plugin roots and returns the updated snapshot. */
    refresh(): Promise<PluginHostSnapshot>;
    setTrusted(pluginId: string, trusted: boolean): Promise<PluginHostSnapshot>;
    setEnabled(pluginId: string, enabled: boolean): Promise<PluginHostSnapshot>;
    /** Forwards a renderer-side plugin failure so the backend can log it. */
    reportError(pluginId: string, message: string): Promise<void>;
}

/** Inversify token used to inject the RPC proxy for {@link PluginHostClient}. */
export const PluginHostClient = Symbol('PluginHostClient');

/**
 * Renderer → backend calls into services *backend plugins* provided.
 *
 * This is the only cross-boundary service path: it reuses Theia's existing
 * channel, so no per-plugin process, socket or sandbox is introduced. Only
 * JSON-serializable arguments and results are supported.
 */
export interface PluginServiceBridge {
    /** Ids of every service currently provided by a backend plugin. */
    listServices(): Promise<readonly string[]>;
    invoke(serviceId: string, method: string, args: readonly unknown[]): Promise<unknown>;
}

/** Inversify token used to inject the RPC proxy for {@link PluginServiceBridge}. */
export const PluginServiceBridge = Symbol('PluginServiceBridge');
