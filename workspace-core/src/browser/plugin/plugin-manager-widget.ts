import * as React from 'react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { nls } from '@theia/core/lib/common/nls';
import type { PluginHostSnapshot } from '../../common/plugin-host-protocol.js';
import { PluginManager } from './plugin-manager.js';
import * as styles from './plugin-manager-styles.js';

/**
 * Plugin manager surface: lists discovered plugins with their trust and enable
 * state and lets the user toggle the latter. Layout lives in
 * `plugin-manager-styles.ts` so this file stays about state, not pixels.
 */
@injectable()
export class PluginManagerWidget extends ReactWidget {
    static readonly ID = 'icebox.plugin-manager';
    static readonly LABEL = nls.localize('icebox/pluginManager', 'Plugins');

    protected snapshot: PluginHostSnapshot | undefined;
    protected unsubscribe: (() => void) | undefined;

    constructor(
        @inject(PluginManager) protected readonly manager: PluginManager,
        @inject(MessageService) protected readonly messages: MessageService
    ) {
        super();
        // `ApplicationShell.addWidget` rejects a widget without an id, so the
        // fixed id has to be set at construction time, not on attach.
        this.id = PluginManagerWidget.ID;
        this.title.label = PluginManagerWidget.LABEL;
        this.title.caption = PluginManagerWidget.LABEL;
        this.title.closable = true;
        this.addClass('icebox-plugin-manager');
    }

    protected override onAfterAttach(): void {
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
            return React.createElement('div', { style: styles.LOADING_STYLE }, 'Loading plugins…');
        }
        const enabled = snapshot.plugins.filter(plugin => snapshot.enabled.includes(plugin.id)).length;
        return React.createElement(
            'div',
            { style: styles.PANEL_STYLE },
            React.createElement(
                'div',
                { style: styles.HEADER_ROW_STYLE },
                React.createElement('h3', { style: styles.HEADING_STYLE }, 'Discovered plugins'),
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        style: styles.BUTTON_STYLE,
                        title: 'Re-read the plugin folders, so a folder added or removed while the app runs is picked up.',
                        onClick: () => void this.rescan()
                    },
                    'Refresh'
                )
            ),
            React.createElement(
                'p',
                { style: styles.SUMMARY_STYLE },
                `${snapshot.plugins.length} plugin${snapshot.plugins.length === 1 ? '' : 's'} · ${enabled} enabled`
            ),
            snapshot.plugins.length === 0
                ? React.createElement('p', { style: styles.EMPTY_STYLE }, 'No plugins found.')
                : React.createElement(
                      'ul',
                      { style: styles.LIST_STYLE },
                      snapshot.plugins.map((plugin, index) =>
                          this.renderPlugin(plugin, snapshot, index === snapshot.plugins.length - 1)
                      )
                  ),
            snapshot.diagnostics.length > 0
                ? React.createElement(
                      'details',
                      { style: styles.DIAGNOSTICS_STYLE },
                      React.createElement(
                          'summary',
                          { style: styles.DIAGNOSTICS_SUMMARY_STYLE },
                          `${snapshot.diagnostics.length} problem(s)`
                      ),
                      React.createElement(
                          'ul',
                          { style: styles.DIAGNOSTICS_LIST_STYLE },
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
        snapshot: PluginHostSnapshot,
        last: boolean
    ): React.ReactNode {
        const trusted = plugin.builtIn || snapshot.trusted.includes(plugin.id);
        const enabled = snapshot.enabled.includes(plugin.id);
        return React.createElement(
            'li',
            { key: plugin.id, style: last ? styles.ITEM_STYLE : { ...styles.ITEM_STYLE, ...styles.ITEM_SEPARATOR } },
            React.createElement(
                'div',
                { style: styles.TEXT_COLUMN_STYLE },
                React.createElement(
                    'div',
                    { style: styles.TITLE_ROW_STYLE },
                    React.createElement('span', { style: styles.NAME_STYLE }, plugin.name),
                    React.createElement('span', { style: styles.ID_STYLE }, `${plugin.id}@${plugin.version}`),
                    plugin.builtIn ? React.createElement('span', { style: styles.BADGE_STYLE }, 'built-in') : undefined,
                    // Trust is granted by the confirmation dialog the first enable
                    // opens, so the row reports it rather than offering a toggle that
                    // can only revoke it.
                    plugin.builtIn
                        ? undefined
                        : React.createElement(
                              'span',
                              { style: styles.BADGE_STYLE },
                              trusted ? 'trusted' : 'needs trust'
                          ),
                    enabled ? undefined : React.createElement('span', { style: styles.BADGE_STYLE }, 'disabled')
                ),
                plugin.description
                    ? React.createElement('span', { style: styles.DESCRIPTION_STYLE }, plugin.description)
                    : undefined
            ),
            React.createElement(
                'div',
                { style: styles.ACTIONS_STYLE },
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        // Enabling is the primary action of an inactive row.
                        style: enabled ? styles.BUTTON_STYLE : styles.PRIMARY_BUTTON_STYLE,
                        title: enabled
                            ? 'Stop this plugin and close the panels it owns.'
                            : 'Activate this plugin. Third-party plugins ask for full-system-access confirmation first.',
                        onClick: () => void this.toggleEnabled(plugin.id, !enabled)
                    },
                    enabled ? 'Disable' : 'Enable'
                )
            )
        );
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

    /** Re-reads the plugin folders; a folder dropped in while running shows up here. */
    protected async rescan(): Promise<void> {
        try {
            await this.manager.refresh();
            this.snapshot = this.manager.getSnapshot();
            this.update();
        } catch (error) {
            await this.messages.error(error instanceof Error ? error.message : String(error));
        }
    }
}
