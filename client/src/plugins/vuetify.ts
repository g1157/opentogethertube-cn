import "vuetify/styles";
import { createVuetify, type ThemeDefinition } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { aliases, mdi } from "vuetify/iconsets/mdi-svg";

const themeDark: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#ffbe3d",
		"primary-lighten-1": "#ffd271",
		"primary-darken-1": "#e89a1c",
		secondary: "#4fe6df",
		background: "#100d0a",
		surface: "#181310",
		"on-background": "#f6ecd9",
		"on-surface": "#f6ecd9",
		"on-primary": "#1a1206",
		success: "#8ad96b",
		warning: "#ffb13d",
		error: "#ff5a4d",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeLight: ThemeDefinition = {
	dark: false,
	colors: {
		primary: "#d97706",
		"primary-lighten-1": "#f59e0b",
		"primary-darken-1": "#b45309",
		secondary: "#0d8b8f",
		background: "#f6efe1",
		surface: "#fffdf8",
		"on-background": "#2a1c0b",
		"on-surface": "#2a1c0b",
		"on-primary": "#fff8ec",
		success: "#2f8f3e",
		warning: "#c2740a",
		error: "#c4362a",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeDeepRed: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#ff3b5c",
		"primary-lighten-1": "#ff6f86",
		"primary-darken-1": "#d11036",
		secondary: "#ffae54",
		background: "#220610",
		surface: "#310a18",
		"on-background": "#ffe7ec",
		"on-surface": "#ffe7ec",
		"on-primary": "#2a0309",
		success: "#44c98a",
		warning: "#ffae54",
		error: "#ff5470",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeDeepBlue: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#4fb6ff",
		"primary-lighten-1": "#87d0ff",
		"primary-darken-1": "#1c8fe6",
		secondary: "#5ef0d8",
		background: "#051628",
		surface: "#082035",
		"on-background": "#e2f3ff",
		"on-surface": "#e2f3ff",
		"on-primary": "#04121f",
		success: "#4fe0b0",
		warning: "#ffc04f",
		error: "#ff6b6b",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeGreenSlate: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#5cf07f",
		"primary-lighten-1": "#8dff9f",
		"primary-darken-1": "#2fc257",
		secondary: "#e4d36a",
		background: "#0e150e",
		surface: "#151f15",
		"on-background": "#e7f6e2",
		"on-surface": "#e7f6e2",
		"on-primary": "#061206",
		success: "#5cf07f",
		warning: "#efeb68",
		error: "#ff7a6a",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeStrawberry: ThemeDefinition = {
	dark: false,
	colors: {
		primary: "#e8035f",
		"primary-lighten-1": "#ff4d8d",
		"primary-darken-1": "#b80049",
		secondary: "#2f9457",
		background: "#fff0f5",
		surface: "#fffafc",
		"on-background": "#4a0f29",
		"on-surface": "#4a0f29",
		"on-primary": "#fff",
		success: "#2f9457",
		warning: "#e0801f",
		error: "#c8123f",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const vuetify = createVuetify({
	components,
	directives,
	icons: {
		defaultSet: "mdi",
		aliases,
		sets: {
			mdi,
		},
	},
	theme: {
		defaultTheme: "dark",
		themes: {
			dark: themeDark,
			light: themeLight,
			deepred: themeDeepRed,
			deepblue: themeDeepBlue,
			greenslate: themeGreenSlate,
			strawberry: themeStrawberry,
		},
	},
});

export default vuetify;
