import type { BackendPluginAPI } from '@brucede/plugin-api';

/**
 * Native Node backend entrypoint for terminal.
 * Register services/events here and dispose every resource with the plugin lifecycle.
 */
export function activate(_api: BackendPluginAPI): void {
    // Implement the real terminal backend services in this plugin package.
}
