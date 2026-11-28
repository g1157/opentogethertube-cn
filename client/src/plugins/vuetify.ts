import "vuetify/styles";
import { createVuetify, type ThemeDefinition } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi-svg";
import palettes from "@/styles/theme-palettes.json";

type Palette = {
	dark: boolean;
	colors: Record<string, string>;
};

// The palette lives in one JSON file. `client/scripts/generate-theme-css.mjs` derives the
// CSS custom properties in `_theme-vars.generated.scss` from the same source, so the
// Vuetify theme and the shadcn-style variables cannot drift apart (D4).
const themes = Object.fromEntries(
	Object.entries(palettes as Record<string, Palette>).map(([name, palette]) => [
		name,
		{ dark: palette.dark, colors: palette.colors } satisfies ThemeDefinition,
	]),
);

const vuetify = createVuetify({
	icons: {
		defaultSet: "mdi",
		aliases,
		sets: {
			mdi,
		},
	},
	theme: {
		defaultTheme: "teal",
		themes,
	},
});

export default vuetify;
