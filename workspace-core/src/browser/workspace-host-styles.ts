import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';

const STYLE_ELEMENT_ID = 'icebox-host-styles';

/**
 * Host CSS that keeps native panels operable.
 *
 * Theia shows a tab's caption as a tooltip when the pointer enters the tab. The
 * tooltip is a **top-layer popover** positioned directly below the tab — that is,
 * on top of the panel's own first rows — and it keeps pointer events, so a click
 * there is consumed by the tooltip instead of reaching the panel underneath. In
 * a terminal the first rows are exactly where the prompt is: clicking to focus
 * the terminal dismisses the tooltip, the terminal is blurred instead of focused,
 * its cursor turns hollow, and every keystroke goes to the document body. The
 * terminal looks frozen while it is simply not the focused element.
 *
 * The tooltip is inert text, so letting clicks through costs nothing. Theia's
 * interactive hover variants (an enhanced tab preview with buttons, sidebars,
 * status bar) carry their own class or position and keep their pointer events.
 */
const HOST_STYLES = `
.theia-hover.bottom:not(.extended-tab-preview) {
    pointer-events: none;
}
`;

/**
 * Installs the rules above once, for the lifetime of the window.
 *
 * The styles live in a style element rather than a `.css` file because
 * workspace-core compiles with plain `tsc` and is not bundled: there is no
 * stylesheet pipeline for host code, and a stylesheet the shell never imports
 * would be dead weight.
 */
@injectable()
export class WorkspaceHostStyles implements FrontendApplicationContribution {
    onStart(): void {
        if (document.getElementById(STYLE_ELEMENT_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ELEMENT_ID;
        style.textContent = HOST_STYLES;
        document.head.appendChild(style);
    }
}
