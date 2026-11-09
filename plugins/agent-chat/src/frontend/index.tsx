import type { FrontendPluginAPI } from '@brucede/plugin-api';

/**
 * Native renderer entrypoint for agent chat.
 * Register panel factories through api.panels; do not choose dock placement here.
 */
export function activate(_api: FrontendPluginAPI): void {
    // Implement the real agent chat panel in this plugin package.
}
