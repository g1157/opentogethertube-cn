import type { ThemeDefinition } from "vuetify";
import vuetify from "@/plugins/vuetify";

/**
 * The colour the browser paints its own chrome with (address bar, PWA status bar) while
 * the page is visible. It has to follow the active theme — a light theme under a dark
 * status bar looks like a rendering bug.
 *
 * The colours come from the same Vuetify theme definitions the rest of the interface
 * reads, so there is no second copy of the palette to keep in sync (D4). `index.html`
 * carries `DEFAULT_THEME_COLOR` for the moment before the store has loaded.
 */

/** Background of the default theme (`teal`), also written into `index.html`. */
export const DEFAULT_THEME_COLOR = "#04191c";

function backgrounds(): Record<string, ThemeDefinition> {
	return vuetify.theme.themes.value as Record<string, ThemeDefinition>;
}

/** Background colour of a theme, or the default when the name is not a known theme. */
export function themeBackgroundColor(theme: string): string {
	const background = backgrounds()[theme]?.colors?.background;
	return typeof background === "string" ? background : DEFAULT_THEME_COLOR;
}

/** Rewrites `<meta name="theme-color">` for the given theme. A no-op outside the DOM. */
export function applyThemeColor(theme: string): void {
	if (typeof document === "undefined") {
		return;
	}
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		return;
	}
	meta.content = themeBackgroundColor(theme);
}
