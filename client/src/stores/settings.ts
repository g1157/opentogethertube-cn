import type { RoomSettings } from "ott-common";
import type { Module } from "vuex/types";
import vuetify from "@/plugins/vuetify";

export interface SettingsState {
	volume: number;
	muted: boolean;
	audioBoost: number;
	locale: string;
	roomLayout: RoomLayoutMode;
	theme: Theme;
	sfxEnabled: boolean;
	sfxVolume: number;
	defaultRoomSettings?: DefaultRoomSettings;
	enableAdapterSelector: boolean;
	swipeSeekSeconds: 5 | 10 | 30;
}

export type DefaultRoomSettings = Pick<RoomSettings, "autoSkipSegmentCategories">;

export enum RoomLayoutMode {
	default = "default",
	theater = "theater",
}

export enum Theme {
	dark = "dark",
	light = "light",
	deepred = "deepred",
	deepblue = "deepblue",
	greenslate = "greenslate",
	strawberry = "strawberry",
}

export const ALL_THEMES = Object.keys(Theme).filter(key => Theme[key]);

const DEFAULT_LOCALE_VERSION = "v0.15.0-cn3";
type StoredSettings = Partial<SettingsState> & { defaultLocaleVersion?: string };

export const settingsModule: Module<SettingsState, unknown> = {
	namespaced: true,
	state: () => ({
		volume: 100,
		muted: false,
		audioBoost: 100,
		locale: "zh-CN",
		roomLayout: RoomLayoutMode.default,
		theme: Theme.dark,
		sfxEnabled: true,
		sfxVolume: 0.8,
		enableAdapterSelector: false,
		swipeSeekSeconds: 10,
	}),
	mutations: {
		UPDATE(state, settings: Partial<SettingsState>) {
			Object.assign(state, settings);
			if (![5, 10, 30].includes(state.swipeSeekSeconds)) {
				state.swipeSeekSeconds = 10;
			}
			try {
				// Keep the migration marker and language in one write so they cannot diverge.
				localStorage.setItem(
					"settings",
					JSON.stringify({ ...state, defaultLocaleVersion: DEFAULT_LOCALE_VERSION }),
				);
			} catch {
				// Private browsing or storage limits must not prevent settings from working in memory.
			}

			// apply some global settings
			if (settings.theme !== undefined) {
				if (ALL_THEMES.includes(settings.theme)) {
					vuetify.theme.global.name.value = settings.theme;
				} else {
					console.warn(
						`Can't apply invalid theme: ${settings.theme}, defaulting to dark theme`,
					);
					vuetify.theme.global.name.value = Theme.dark;
				}
			}
		},
	},
	actions: {
		load(context) {
			let loaded: StoredSettings = {};
			try {
				const value: unknown = JSON.parse(localStorage.getItem("settings") ?? "{}");
				if (value && typeof value === "object" && !Array.isArray(value)) {
					loaded = value as StoredSettings;
				}
			} catch {
				// Invalid or unavailable browser storage falls back to this release's defaults.
			}
			const { defaultLocaleVersion, ...settings } = loaded;
			if (
				defaultLocaleVersion !== DEFAULT_LOCALE_VERSION ||
				typeof settings.locale !== "string" ||
				settings.locale.trim() === ""
			) {
				settings.locale = "zh-CN";
			}
			context.commit("UPDATE", settings);
		},
	},
};
