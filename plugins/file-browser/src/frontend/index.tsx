import type { FrontendPluginAPI } from '@brucede/plugin-api';

/**
 * Native renderer entrypoint for file browser.
 * Register panel factories through api.panels; do not choose dock placement here.
 */
export function activate(_api: FrontendPluginAPI): void {
    // Implement the real file browser panel in this plugin package.
}
