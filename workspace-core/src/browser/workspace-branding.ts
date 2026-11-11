import { injectable } from '@theia/core/shared/inversify';
import { Theme } from '@theia/core/lib/common/theme';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { IconThemeDefinition, IconThemeService } from '@theia/core/lib/browser/icon-theme-service';

/**
 * Theia brands its bundled themes and icon themes with its own name, which puts
 * "(Theia)" in front of the user in the color-theme and file-icon pickers and in
 * the matching preference dropdowns. Icebox ships those themes as its own, so
 * they carry the application's name instead.
 *
 * `(Theia)` is rewritten rather than stripped so the labels stay distinguishable
 * from a plugin's future theme contributions, and the rewrite is the only
 * difference: ids, colors, activation and the persisted preference value are
 * untouched, so an existing `workbench.colorTheme` keeps working.
 */
const THEIA_BRAND = '(Theia)';

function brand(label: string): string {
    return label.replace(THEIA_BRAND, '(Icebox)');
}

/**
 * Rebrands the color themes as they are listed.
 *
 * Only the listing is rewritten; `getTheme(id)`/`getCurrentTheme()` keep
 * returning the real instances, so activation, theming and preference
 * validation are unchanged. Rebranding here also reaches the preference
 * dropdown: `ThemeService` derives its `workbench.colorTheme` enum labels from
 * this listing.
 */
@injectable()
export class WorkspaceThemeService extends ThemeService {
    override getThemes(): Theme[] {
        return super.getThemes().map(theme => ({ ...theme, label: brand(theme.label) }))
            .filter(theme => theme.label !== undefined);
    }
}

/**
 * Rebrands the icon themes, and with them the `workbench.iconTheme` dropdown,
 * because `IconThemeService` builds that enum from `definitions` too.
 */
@injectable()
export class WorkspaceIconThemeService extends IconThemeService {
    override get definitions(): IterableIterator<IconThemeDefinition> {
        return [...super.definitions]
            .map(definition => ({ ...definition, label: brand(definition.label) }))
            .values();
    }
}
