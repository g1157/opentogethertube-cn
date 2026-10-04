import type { RoomSettings } from "ott-common";
import type { Module } from "vuex/types";
import vuetify from "@/plugins/vuetify";

export const CHAT_OVERLAY_SECONDS_OPTIONS = [0, 3, 5, 10, 20] as const;
export const ROOM_NOTICE_SECONDS_OPTIONS = [0, 1, 2, 3, 5, 10, 20] as const;
export const CONTROLS_HIDE_SECONDS_OPTIONS = [2, 3, 5, 10] as const;
/**
 * Forward buffering target for the players that own their buffer (HLS and DASH). The value is
 * the target, not a hard cap: a fast connection keeps loading past it, up to a byte budget
 * that follows the device's memory. 300s is for long films on a stable line.
 */
export const HLS_BUFFER_SECONDS_OPTIONS = [30, 60, 120, 300] as const;
/** Default leans deep: a room stall pauses everyone, and the target is not a hard cap. */
export const DEFAULT_HLS_BUFFER_SECONDS: (typeof HLS_BUFFER_SECONDS_OPTIONS)[number] = 120;
export const UPSCALE_MODES = [
	"off",
	"sharpen",
	"film",
	"anime4k",
	"anime4k-quality",
	// mpv's "Mode A+A (HQ)" chain on WebGL2, for devices without a usable WebGPU. Heavier than
	// everything else here: about 55 passes per frame.
	"anime4k-ultra",
] as const;
/**
 * "anime4k-quality" runs the heavier A+A preset (Restore -> Upscale -> Restore -> Upscale)
 * instead of the fast one. Same upscale, roughly double the GPU cost, WebGPU only.
 */
export type UpscaleMode = (typeof UPSCALE_MODES)[number];

/**
 * What the enhancement layer renders. "off" never mounts the layer, so the layer only
 * ever sees the three rendering tiers.
 */
export function enhancementLayerMode(mode: UpscaleMode): Exclude<UpscaleMode, "off"> {
	return mode === "off" ? "sharpen" : mode;
}

/** Render multipliers for the enhancement canvas; "auto" follows the displayed box. */
export const UPSCALE_SCALES = ["auto", 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3] as const;
export const MIN_UPSCALE_STRENGTH = 0.4;
export const MAX_UPSCALE_STRENGTH = 1.2;
/**
 * The shader clamps every sharpened pixel to its neighbourhood, so the top of the range
 * cannot halo; the default sits high enough that the tier is actually visible.
 */
export const DEFAULT_UPSCALE_STRENGTH = 0.9;
/**
 * What the early phone default used to store. Kept as the fingerprint of that machine-set
 * value: the one-time migration in `load` resets a session carrying exactly this strength
 * (with the "sharpen" tier), and never a value the visitor picked.
 */
export const PHONE_UPSCALE_STRENGTH = 0.4;

/**
 * External danmaku (bullet comments) fetched for girigiri sources. Speeds multiply the
 * reference 8 s traverse (higher is faster), so users can calm a busy track down.
 */
export const DANMAKU_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const DANMAKU_FONT_SIZE_OPTIONS = ["small", "medium", "large"] as const;
/**
 * Which part of the picture the comments may use. "top"/"bottom" halve the lane band, the
 * way Bilibili's 显示区域 does, so a half-screen of subtitles or a face stays readable.
 */
export const DANMAKU_AREAS = ["full", "top", "bottom"] as const;
export type DanmakuArea = (typeof DANMAKU_AREAS)[number];
/**
 * How many comments are let through per second. "high" keeps the historical behavior
 * (every comment the lanes can hold), so the default does not quietly thin a track.
 */
export const DANMAKU_DENSITY_OPTIONS = ["low", "medium", "high"] as const;
export type DanmakuDensity = (typeof DANMAKU_DENSITY_OPTIONS)[number];
export const DANMAKU_MAX_PER_SECOND: Record<DanmakuDensity, number> = {
	low: 3,
	medium: 8,
	high: Number.POSITIVE_INFINITY,
};

/**
 * Tone presets for this device's audio graph (Web Audio peaking filters over the source's
 * own mix). "off" leaves the mix untouched; the rest are per-device listening corrections.
 */
export const AUDIO_EQ_PRESETS = ["off", "bass", "vocal"] as const;
export type AudioEqPreset = (typeof AUDIO_EQ_PRESETS)[number];

/** How the picture fills the player box; "cover" crops the edges instead of letterboxing. */
export const VIDEO_FILL_MODES = ["contain", "cover"] as const;
export type VideoFillMode = (typeof VIDEO_FILL_MODES)[number];

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
	/** How far one seek goes, whatever asked for it: a swipe or an arrow key. */
	seekSeconds: 5 | 10 | 30;
	chatOverlaySeconds: (typeof CHAT_OVERLAY_SECONDS_OPTIONS)[number];
	presenceNoticeSeconds: (typeof ROOM_NOTICE_SECONDS_OPTIONS)[number];
	seekNoticeSeconds: (typeof ROOM_NOTICE_SECONDS_OPTIONS)[number];
	controlsHideSeconds: (typeof CONTROLS_HIDE_SECONDS_OPTIONS)[number];
	hlsBufferSeconds: (typeof HLS_BUFFER_SECONDS_OPTIONS)[number];
	upscaleMode: UpscaleMode;
	upscaleStrength: number;
	upscaleScale: (typeof UPSCALE_SCALES)[number];
	upscaleAutoDegrade: boolean;
	/** External danmaku (bullet comments) for the current source; every value applies per device. */
	danmakuEnabled: boolean;
	danmakuOpacity: number;
	danmakuFontSize: (typeof DANMAKU_FONT_SIZE_OPTIONS)[number];
	danmakuSpeed: (typeof DANMAKU_SPEED_OPTIONS)[number];
	/** Part of the picture the comments may use. */
	danmakuDisplayArea: DanmakuArea;
	/** Comments per second; the excess is dropped. */
	danmakuDensity: DanmakuDensity;
	danmakuBlockScroll: boolean;
	danmakuBlockTop: boolean;
	danmakuBlockBottom: boolean;
	danmakuBlockColored: boolean;
	danmakuAntiCollision: boolean;
	/** Base URL of a self-hosted danmu_api aggregator (with its token); empty disables it. */
	danmakuApiBase: string;
	/** Audio tone preset for this device; applied through the player's Web Audio graph. */
	audioEqPreset: AudioEqPreset;
	/** How the picture fills the player box on this device. */
	videoFillMode: VideoFillMode;
	videoMirror: boolean;
	/** Desktop only: whether the room notes panel is expanded next to the video. */
	notesPanelOpen: boolean;
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
	violet = "violet",
	teal = "teal",
	oled = "oled",
	mint = "mint",
}

export const ALL_THEMES = Object.keys(Theme).filter(key => Theme[key]);

/** Themes painted on a light background; anything that adapts to the page needs this list. */
export const LIGHT_THEMES: string[] = [Theme.light, Theme.strawberry, Theme.mint];

const DEFAULT_LOCALE_VERSION = "v0.15.0-cn3";
const DEFAULT_SFX_VERSION = "v0.15.0-cn6";
// Bumped so sessions that stored one of the earlier danmaku defaults (80%, then 30%)
// pick up 40%; a deliberately chosen value is left alone.
const DEFAULT_DANMAKU_OPACITY_VERSION = "v1.3.4";
// Early releases started phones on the light tier by themselves; sessions carrying exactly
// that machine-set pair are moved back to off once, and only once.
const DEFAULT_UPSCALE_VERSION = "v1.3.10";
// The room notices and the collapsed-chat overlay now start at the shortest tier that
// still shows (3s overlay, 1s join/leave and seek); the longer durations earlier releases
// shipped (5s overlay, 3s join/leave and seek) move there once.
const DEFAULT_NOTICE_VERSION = "v1.3.10";
type StoredSettings = Partial<SettingsState> & {
	defaultLocaleVersion?: string;
	defaultSfxVersion?: string;
	defaultDanmakuOpacityVersion?: string;
	defaultUpscaleVersion?: string;
	defaultNoticeVersion?: string;
};

/** Keeps whatever a caller wrote inside the ranges this release understands. */
function normalizeSettings(state: SettingsState) {
	if (typeof state.sfxEnabled !== "boolean") {
		state.sfxEnabled = false;
	}
	if (!Number.isFinite(state.sfxVolume) || state.sfxVolume < 0 || state.sfxVolume > 1) {
		state.sfxVolume = 0.8;
	}
	if (![5, 10, 30].includes(state.seekSeconds)) {
		state.seekSeconds = 10;
	}
	if (!CHAT_OVERLAY_SECONDS_OPTIONS.includes(state.chatOverlaySeconds)) {
		state.chatOverlaySeconds = 3;
	}
	if (!ROOM_NOTICE_SECONDS_OPTIONS.includes(state.presenceNoticeSeconds)) {
		state.presenceNoticeSeconds = 1;
	}
	if (!ROOM_NOTICE_SECONDS_OPTIONS.includes(state.seekNoticeSeconds)) {
		state.seekNoticeSeconds = 1;
	}
	if (!CONTROLS_HIDE_SECONDS_OPTIONS.includes(state.controlsHideSeconds)) {
		state.controlsHideSeconds = 3;
	}
	if (!HLS_BUFFER_SECONDS_OPTIONS.includes(state.hlsBufferSeconds)) {
		state.hlsBufferSeconds = DEFAULT_HLS_BUFFER_SECONDS;
	}
	if (!UPSCALE_MODES.includes(state.upscaleMode)) {
		state.upscaleMode = "off";
	}
	if (
		!Number.isFinite(state.upscaleStrength) ||
		state.upscaleStrength < MIN_UPSCALE_STRENGTH ||
		state.upscaleStrength > MAX_UPSCALE_STRENGTH
	) {
		state.upscaleStrength = DEFAULT_UPSCALE_STRENGTH;
	}
	if (!UPSCALE_SCALES.includes(state.upscaleScale)) {
		state.upscaleScale = "auto";
	}
	if (typeof state.upscaleAutoDegrade !== "boolean") {
		state.upscaleAutoDegrade = true;
	}
	if (typeof state.danmakuEnabled !== "boolean") {
		state.danmakuEnabled = true;
	}
	if (!Number.isFinite(state.danmakuOpacity)) {
		state.danmakuOpacity = 1;
	}
	state.danmakuOpacity = Math.min(1, Math.max(0.1, state.danmakuOpacity));
	if (!DANMAKU_FONT_SIZE_OPTIONS.includes(state.danmakuFontSize)) {
		state.danmakuFontSize = "medium";
	}
	if (!DANMAKU_SPEED_OPTIONS.includes(state.danmakuSpeed)) {
		state.danmakuSpeed = 1;
	}
	if (!DANMAKU_AREAS.includes(state.danmakuDisplayArea)) {
		state.danmakuDisplayArea = "full";
	}
	if (!DANMAKU_DENSITY_OPTIONS.includes(state.danmakuDensity)) {
		state.danmakuDensity = "high";
	}
	if (typeof state.danmakuBlockScroll !== "boolean") {
		state.danmakuBlockScroll = false;
	}
	if (typeof state.danmakuBlockTop !== "boolean") {
		state.danmakuBlockTop = false;
	}
	if (typeof state.danmakuBlockBottom !== "boolean") {
		state.danmakuBlockBottom = false;
	}
	if (typeof state.danmakuBlockColored !== "boolean") {
		state.danmakuBlockColored = false;
	}
	if (typeof state.danmakuAntiCollision !== "boolean") {
		state.danmakuAntiCollision = true;
	}
	if (typeof state.danmakuApiBase !== "string") {
		state.danmakuApiBase = "";
	}
	if (!AUDIO_EQ_PRESETS.includes(state.audioEqPreset)) {
		state.audioEqPreset = "off";
	}
	if (!VIDEO_FILL_MODES.includes(state.videoFillMode)) {
		state.videoFillMode = "contain";
	}
	if (typeof state.videoMirror !== "boolean") {
		state.videoMirror = false;
	}
	if (typeof state.notesPanelOpen !== "boolean") {
		state.notesPanelOpen = true;
	}
}

function persistSettings(state: SettingsState) {
	try {
		// Save defaults and their migration markers together so they cannot diverge.
		// Kept synchronous on purpose: tests and the update checker read it right
		// after an UPDATE, and repeated writes are already de-duplicated at the
		// media-player layer (a single shared volume watcher instead of one per caller).
		localStorage.setItem(
			"settings",
			JSON.stringify({
				...state,
				defaultLocaleVersion: DEFAULT_LOCALE_VERSION,
				defaultSfxVersion: DEFAULT_SFX_VERSION,
				defaultDanmakuOpacityVersion: DEFAULT_DANMAKU_OPACITY_VERSION,
				defaultUpscaleVersion: DEFAULT_UPSCALE_VERSION,
				defaultNoticeVersion: DEFAULT_NOTICE_VERSION,
			}),
		);
	} catch {
		// Private browsing or storage limits must not prevent settings from working in memory.
	}
}

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
		seekSeconds: 10,
		chatOverlaySeconds: 3,
		presenceNoticeSeconds: 1,
		seekNoticeSeconds: 1,
		controlsHideSeconds: 3,
		hlsBufferSeconds: DEFAULT_HLS_BUFFER_SECONDS,
		upscaleMode: "off",
		upscaleStrength: DEFAULT_UPSCALE_STRENGTH,
		upscaleScale: "auto",
		upscaleAutoDegrade: true,
		danmakuEnabled: true,
		danmakuOpacity: 0.4,
		danmakuFontSize: "medium",
		danmakuSpeed: 1,
		danmakuDisplayArea: "full",
		danmakuDensity: "high",
		danmakuBlockScroll: false,
		danmakuBlockTop: false,
		danmakuBlockBottom: false,
		danmakuBlockColored: false,
		danmakuAntiCollision: true,
		danmakuApiBase: "",
		audioEqPreset: "off",
		videoFillMode: "contain",
		videoMirror: false,
		notesPanelOpen: true,
	}),
	mutations: {
		UPDATE(state, settings: Partial<SettingsState>) {
			Object.assign(state, settings);
			normalizeSettings(state);
			persistSettings(state);

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
		/**
		 * Same as UPDATE, but nothing is written to localStorage. Session-only corrections —
		 * the auto-degrade ladder, for one — use this so a decision the device forced does not
		 * replace the setting the user picked on their next visit.
		 */
		UPDATE_TRANSIENT(state, settings: Partial<SettingsState>) {
			Object.assign(state, settings);
			normalizeSettings(state);
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
			const {
				defaultLocaleVersion,
				defaultSfxVersion,
				defaultDanmakuOpacityVersion,
				defaultUpscaleVersion,
				defaultNoticeVersion,
				...settings
			} = loaded;
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
			if (
				defaultDanmakuOpacityVersion !== DEFAULT_DANMAKU_OPACITY_VERSION &&
				(settings.danmakuOpacity === 0.8 || settings.danmakuOpacity === 0.3)
			) {
				// Only the two defaults we shipped (80%, then 30%) are moved; any other
				// stored value is a choice.
				settings.danmakuOpacity = 0.4;
			}
			// The picture enhancement is off by default on every device. An early release
			// started phones on the light tier by itself, so a session carrying exactly that
			// machine-set pair moves back to off once — a tier or strength the visitor picked
			// (anything but "sharpen" with the old phone strength) is never overridden.
			if (
				defaultUpscaleVersion !== DEFAULT_UPSCALE_VERSION &&
				settings.upscaleMode === "sharpen" &&
				settings.upscaleStrength === PHONE_UPSCALE_STRENGTH
			) {
				settings.upscaleMode = "off";
				settings.upscaleStrength = DEFAULT_UPSCALE_STRENGTH;
			}
			// The notices open at the shortest tier that still shows now; only the exact
			// durations shipped before (5s overlay, 3s join/leave and seek) are moved, any
			// other stored value is a choice (including turning the notices off).
			if (defaultNoticeVersion !== DEFAULT_NOTICE_VERSION) {
				if (settings.chatOverlaySeconds === 5) {
					settings.chatOverlaySeconds = 3;
				}
				if (settings.presenceNoticeSeconds === 3) {
					settings.presenceNoticeSeconds = 1;
				}
				if (settings.seekNoticeSeconds === 3) {
					settings.seekNoticeSeconds = 1;
				}
			}
			context.commit("UPDATE", settings);
		},
	},
};
