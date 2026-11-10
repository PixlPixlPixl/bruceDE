import * as React from 'react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { nls } from '@theia/core/lib/common/nls';
import type { PluginHostSnapshot } from '../../common/plugin-host-protocol.js';
import { PluginManager } from './plugin-manager.js';

/**
 * Minimal plugin manager surface: lists discovered plugins with their trust and
 * enable state, and lets the user toggle either. Rendering is intentionally
 * plain — the point of this first pass is the runtime contract behind it.
 */
@injectable()
export class PluginManagerWidget extends ReactWidget {
    static readonly ID = 'bruce.plugin-manager';
    static readonly LABEL = nls.localize('brucede/pluginManager', 'Plugins');

    protected snapshot: PluginHostSnapshot | undefined;
    protected unsubscribe: (() => void) | undefined;

    constructor(
        @inject(PluginManager) protected readonly manager: PluginManager,
        @inject(MessageService) protected readonly messages: MessageService
    ) {
        super();
    }

    protected override onAfterAttach(): void {
        this.addClass('bruce-plugin-manager');
        this.unsubscribe = this.manager.onDidChangeSnapshot(snapshot => {
            this.snapshot = snapshot;
            this.update();
        });
        this.snapshot = this.manager.getSnapshot();
        this.update();
    }

    protected override onBeforeDetach(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    protected render(): React.ReactNode {
        const snapshot = this.snapshot;
        if (!snapshot) {
            return React.createElement('div', { className: 'bruce-plugin-manager-loading' }, 'Loading plugins…');
        }
        return React.createElement(
            'div',
            { className: 'bruce-plugin-manager-body' },
            React.createElement('h3', undefined, 'Discovered plugins'),
            snapshot.plugins.length === 0
                ? React.createElement('p', undefined, 'No plugins found.')
                : React.createElement(
                      'ul',
                      { className: 'bruce-plugin-list' },
                      snapshot.plugins.map(plugin => this.renderPlugin(plugin, snapshot))
                  ),
            snapshot.diagnostics.length > 0
                ? React.createElement(
                      'details',
                      { className: 'bruce-plugin-diagnostics' },
                      React.createElement('summary', undefined, `${snapshot.diagnostics.length} problem(s)`),
                      React.createElement(
                          'ul',
                          undefined,
                          snapshot.diagnostics.map((diagnostic, index) =>
                              React.createElement(
                                  'li',
                                  { key: index },
                                  `${diagnostic.pluginId ?? diagnostic.directory}: ${diagnostic.message}`
                              )
                          )
                      )
                  )
                : undefined
        );
    }

    protected renderPlugin(
        plugin: PluginHostSnapshot['plugins'][number],
        snapshot: PluginHostSnapshot
    ): React.ReactNode {
        const trusted = snapshot.trusted.includes(plugin.id);
        const enabled = snapshot.enabled.includes(plugin.id);
        return React.createElement(
            'li',
            { key: plugin.id, className: 'bruce-plugin-item' },
            React.createElement('strong', undefined, plugin.name),
            React.createElement('span', { className: 'bruce-plugin-id' }, ` ${plugin.id}@${plugin.version}`),
            plugin.builtIn ? React.createElement('span', { className: 'bruce-plugin-badge' }, ' built-in') : undefined,
            React.createElement('div', { className: 'bruce-plugin-actions' },
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        disabled: !plugin.builtIn && !trusted,
                        title: trusted
                            ? 'Full system access has been granted to this plugin.'
                            : 'Accept the full-system-access warning to trust this plugin.',
                        onClick: () => void this.toggleTrust(plugin.id, !trusted)
                    },
                    trusted ? 'Trusted' : 'Trust…'
                ),
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        onClick: () => void this.toggleEnabled(plugin.id, !enabled)
                    },
                    enabled ? 'Disable' : 'Enable'
                )
            )
        );
    }

    protected async toggleTrust(pluginId: string, trusted: boolean): Promise<void> {
        try {
            // Trust is granted through the same confirmation dialog as enabling
            // third-party code; disabling trust implies disabling the plugin.
            if (trusted) {
                await this.manager.setEnabled(pluginId, true);
            } else {
                await this.manager.setEnabled(pluginId, false);
            }
            this.snapshot = this.manager.getSnapshot();
            this.update();
        } catch (error) {
            await this.messages.error(error instanceof Error ? error.message : String(error));
        }
    }

    protected async toggleEnabled(pluginId: string, enabled: boolean): Promise<void> {
        try {
            await this.manager.setEnabled(pluginId, enabled);
            this.snapshot = this.manager.getSnapshot();
            this.update();
        } catch (error) {
            await this.messages.error(error instanceof Error ? error.message : String(error));
        }
    }
}
