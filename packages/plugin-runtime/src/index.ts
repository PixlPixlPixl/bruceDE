/**
 * Cordis core is safe to use in either normal Theia host context.
 */
export { Context } from '@deepseek-ai/cordis';
export type { Fiber } from '@deepseek-ai/cordis';
export { DisposerBag, toDisposer } from './disposal.js';
export {
    PLUGIN_ID_PATTERN,
    PluginManifestError,
    SUPPORTED_API_VERSIONS,
    satisfiesVersion,
    validatePluginManifest
} from './manifest.js';
export {
    CordisPluginManager,
    type CordisPluginManagerOptions,
    type PluginLoadRequest,
    type PluginModule,
    type PluginRuntimeRecord,
    type PluginRuntimeState
} from './manager.js';
