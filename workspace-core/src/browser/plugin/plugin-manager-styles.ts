import type { CSSProperties } from 'react';

/**
 * Styling for the plugin manager panel.
 *
 * Kept out of the widget so the render logic reads as a list of parts, and kept
 * as plain objects (not CSS classes) because the panel is a ReactWidget rendered
 * by the host with no stylesheet of its own. Only `--theia-*` tokens are used, so
 * the panel follows the active theme instead of carrying its own colours.
 */

/** Panel edges: one padding, applied once, so every row shares the same gutter. */
export const PANEL_STYLE: CSSProperties = {
    boxSizing: 'border-box',
    height: '100%',
    overflowY: 'auto',
    padding: '14px 16px',
    background: 'var(--theia-editor-background)',
    color: 'var(--theia-editor-foreground)',
    fontFamily: 'var(--theia-ui-font-family)',
    fontSize: 'var(--theia-ui-font-size1)'
};

export const LOADING_STYLE: CSSProperties = {
    padding: '14px 16px',
    opacity: 0.7
};

export const HEADING_STYLE: CSSProperties = {
    margin: '0 0 4px',
    fontSize: '13px',
    fontWeight: 600
};

/** One muted line under the heading: discovered count, enabled count. */
export const SUMMARY_STYLE: CSSProperties = {
    margin: '0 0 12px',
    color: 'var(--theia-descriptionForeground)',
    fontSize: '11px'
};

export const LIST_STYLE: CSSProperties = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '4px'
};

/** Row: text on the left, actions on the right, wrapping when the panel is narrow. */
export const ITEM_STYLE: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '8px 16px',
    padding: '10px 12px'
};

export const ITEM_SEPARATOR: CSSProperties = {
    borderBottom: '1px solid var(--theia-panel-border)'
};

export const TEXT_COLUMN_STYLE: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    minWidth: 0,
    flex: '1 1 240px'
};

export const TITLE_ROW_STYLE: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px'
};

export const NAME_STYLE: CSSProperties = {
    fontWeight: 600
};

export const ID_STYLE: CSSProperties = {
    color: 'var(--theia-descriptionForeground)',
    fontSize: '11px'
};

/** Small pill for `built-in` / `enabled` markers. */
export const BADGE_STYLE: CSSProperties = {
    padding: '1px 7px',
    border: '1px solid var(--theia-panel-border)',
    borderRadius: '9px',
    color: 'var(--theia-descriptionForeground)',
    fontSize: '9px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase'
};

export const DESCRIPTION_STYLE: CSSProperties = {
    color: 'var(--theia-descriptionForeground)',
    fontSize: '12px',
    lineHeight: 1.4
};

/** Button group: fixed width per button so Enable/Disable never shift the row. */
export const ACTIONS_STYLE: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginLeft: 'auto'
};

export const BUTTON_STYLE: CSSProperties = {
    minWidth: '84px',
    padding: '4px 12px',
    border: 'none',
    borderRadius: '3px',
    background: 'var(--theia-button-secondaryBackground)',
    color: 'var(--theia-button-secondaryForeground)',
    font: 'inherit',
    fontSize: '12px',
    cursor: 'pointer'
};

export const PRIMARY_BUTTON_STYLE: CSSProperties = {
    ...BUTTON_STYLE,
    background: 'var(--theia-button-background)',
    color: 'var(--theia-button-foreground)'
};

export const DISABLED_BUTTON_STYLE: CSSProperties = {
    opacity: 0.5,
    cursor: 'default'
};

export const DIAGNOSTICS_STYLE: CSSProperties = {
    marginTop: '16px',
    fontSize: '12px'
};

export const DIAGNOSTICS_SUMMARY_STYLE: CSSProperties = {
    cursor: 'pointer',
    color: 'var(--theia-descriptionForeground)'
};

export const DIAGNOSTICS_LIST_STYLE: CSSProperties = {
    margin: '8px 0 0',
    paddingLeft: '18px',
    lineHeight: 1.5
};

export const EMPTY_STYLE: CSSProperties = {
    margin: 0,
    padding: '10px 12px',
    color: 'var(--theia-descriptionForeground)'
};
