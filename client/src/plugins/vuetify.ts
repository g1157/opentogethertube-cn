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

const themeViolet: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#a06bff",
		"primary-lighten-1": "#c39bff",
		"primary-darken-1": "#7847dd",
		secondary: "#5ee0ff",
		background: "#0f0a1a",
		surface: "#181026",
		"on-background": "#f0e9ff",
		"on-surface": "#f0e9ff",
		"on-primary": "#150a26",
		success: "#7ee39a",
		warning: "#ffc46b",
		error: "#ff6b8a",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeTeal: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#2fd8c8",
		"primary-lighten-1": "#6ff0e2",
		"primary-darken-1": "#12b3a4",
		secondary: "#ffd166",
		background: "#04191c",
		surface: "#08262a",
		"on-background": "#e0faf7",
		"on-surface": "#e0faf7",
		"on-primary": "#032125",
		success: "#5ce08f",
		warning: "#ffc46b",
		error: "#ff6b6b",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeOled: ThemeDefinition = {
	dark: true,
	colors: {
		primary: "#ffbe3d",
		"primary-lighten-1": "#ffd271",
		"primary-darken-1": "#e89a1c",
		secondary: "#5ee0ff",
		background: "#000000",
		surface: "#0b0b0b",
		"on-background": "#f2f2f2",
		"on-surface": "#f2f2f2",
		"on-primary": "#1a1206",
		success: "#7ed957",
		warning: "#ffb13d",
		error: "#ff5a4d",
		"media-control-surface": "#ffffff",
		"media-control-background": "#000000",
	},
};

const themeMint: ThemeDefinition = {
	dark: false,
	colors: {
		primary: "#0e8f7a",
		"primary-lighten-1": "#2ab89c",
		"primary-darken-1": "#0a6f5f",
		secondary: "#2f7fa8",
		background: "#eef7f2",
		surface: "#fbfffd",
		"on-background": "#0d2a24",
		"on-surface": "#0d2a24",
		"on-primary": "#f0fffb",
		success: "#1f8f4e",
		warning: "#c2740a",
		error: "#c4362a",
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
		defaultTheme: "teal",
		themes: {
			dark: themeDark,
			light: themeLight,
			deepred: themeDeepRed,
			deepblue: themeDeepBlue,
			greenslate: themeGreenSlate,
			strawberry: themeStrawberry,
			violet: themeViolet,
			teal: themeTeal,
			oled: themeOled,
			mint: themeMint,
		},
	},
});

export default vuetify;
