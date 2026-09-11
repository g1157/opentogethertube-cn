import type { RoomSettings } from "ott-common";
import type { Module } from "vuex/types";
import vuetify from "@/plugins/vuetify";

export const CHAT_OVERLAY_SECONDS_OPTIONS = [0, 3, 5, 10, 20] as const;
export const ROOM_NOTICE_SECONDS_OPTIONS = [0, 1, 2, 3, 5, 10, 20] as const;
export const CONTROLS_HIDE_SECONDS_OPTIONS = [2, 3, 5, 10] as const;
export const HLS_BUFFER_SECONDS_OPTIONS = [30, 60, 120] as const;

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
	chatOverlaySeconds: (typeof CHAT_OVERLAY_SECONDS_OPTIONS)[number];
	presenceNoticeSeconds: (typeof ROOM_NOTICE_SECONDS_OPTIONS)[number];
	seekNoticeSeconds: (typeof ROOM_NOTICE_SECONDS_OPTIONS)[number];
	controlsHideSeconds: (typeof CONTROLS_HIDE_SECONDS_OPTIONS)[number];
	hlsBufferSeconds: (typeof HLS_BUFFER_SECONDS_OPTIONS)[number];
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
const DEFAULT_SFX_VERSION = "v0.15.0-cn6";
type StoredSettings = Partial<SettingsState> & {
	defaultLocaleVersion?: string;
	defaultSfxVersion?: string;
};

export const settingsModule: Module<SettingsState, unknown> = {
	namespaced: true,
	state: () => ({
		volume: 100,
		muted: false,
		audioBoost: 100,
		locale: "zh-CN",
		roomLayout: RoomLayoutMode.default,
		theme: Theme.dark,
		sfxEnabled: false,
		sfxVolume: 0.8,
		enableAdapterSelector: false,
		swipeSeekSeconds: 10,
		chatOverlaySeconds: 5,
		presenceNoticeSeconds: 3,
		seekNoticeSeconds: 3,
		controlsHideSeconds: 3,
		hlsBufferSeconds: 60,
	}),
	mutations: {
		UPDATE(state, settings: Partial<SettingsState>) {
			Object.assign(state, settings);
			if (typeof state.sfxEnabled !== "boolean") {
				state.sfxEnabled = false;
			}
			if (!Number.isFinite(state.sfxVolume) || state.sfxVolume < 0 || state.sfxVolume > 1) {
				state.sfxVolume = 0.8;
			}
			if (![5, 10, 30].includes(state.swipeSeekSeconds)) {
				state.swipeSeekSeconds = 10;
			}
			if (!CHAT_OVERLAY_SECONDS_OPTIONS.includes(state.chatOverlaySeconds)) {
				state.chatOverlaySeconds = 5;
			}
			if (!ROOM_NOTICE_SECONDS_OPTIONS.includes(state.presenceNoticeSeconds)) {
				state.presenceNoticeSeconds = 3;
			}
			if (!ROOM_NOTICE_SECONDS_OPTIONS.includes(state.seekNoticeSeconds)) {
				state.seekNoticeSeconds = 3;
			}
			if (!CONTROLS_HIDE_SECONDS_OPTIONS.includes(state.controlsHideSeconds)) {
				state.controlsHideSeconds = 3;
			}
			if (!HLS_BUFFER_SECONDS_OPTIONS.includes(state.hlsBufferSeconds)) {
				state.hlsBufferSeconds = 60;
			}
			try {
				// Save defaults and their migration markers together so they cannot diverge.
				localStorage.setItem(
					"settings",
					JSON.stringify({
						...state,
						defaultLocaleVersion: DEFAULT_LOCALE_VERSION,
						defaultSfxVersion: DEFAULT_SFX_VERSION,
					}),
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
			const { defaultLocaleVersion, defaultSfxVersion, ...settings } = loaded;
			if (
				defaultLocaleVersion !== DEFAULT_LOCALE_VERSION ||
				typeof settings.locale !== "string" ||
				settings.locale.trim() === ""
			) {
				settings.locale = "zh-CN";
			}
			if (defaultSfxVersion !== DEFAULT_SFX_VERSION) {
				settings.sfxEnabled = false;
			}
			context.commit("UPDATE", settings);
		},
	},
};
