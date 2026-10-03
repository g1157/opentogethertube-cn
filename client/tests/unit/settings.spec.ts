import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "vuex";
import vuetify from "@/plugins/vuetify";
import { RoomLayoutMode, settingsModule, type SettingsState, Theme } from "@/stores/settings";

describe("saved settings and default migrations", () => {
	let saved: Map<string, string>;
	let storage: {
		getItem: ReturnType<typeof vi.fn>;
		setItem: ReturnType<typeof vi.fn>;
	};
	const newStore = () =>
		createStore<{ settings: SettingsState }>({ modules: { settings: settingsModule } });

	beforeEach(() => {
		saved = new Map();
		storage = {
			getItem: vi.fn((key: string) => saved.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => saved.set(key, String(value))),
		};
		vi.stubGlobal("localStorage", storage);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vuetify.theme.global.name.value = Theme.dark;
	});

	it("starts new visitors in Simplified Chinese and records the applied default", async () => {
		const store = newStore();
		expect(store.state.settings.locale).toBe("zh-CN");
		await store.dispatch("settings/load");
		expect(store.state.settings.locale).toBe("zh-CN");
		expect(JSON.parse(saved.get("settings")!)).toMatchObject({
			locale: "zh-CN",
			defaultLocaleVersion: "v0.15.0-cn3",
			defaultSfxVersion: "v0.15.0-cn6",
			defaultDanmakuOpacityVersion: "v1.3.4",
			sfxEnabled: false,
		});
		expect(store.state.settings).not.toHaveProperty("defaultLocaleVersion");
		expect(store.state.settings).not.toHaveProperty("defaultSfxVersion");
		expect(store.state.settings).not.toHaveProperty("defaultDanmakuOpacityVersion");
		expect(store.state.settings.sfxEnabled).toBe(false);
		expect(store.state.settings.chatOverlaySeconds).toBe(5);
		expect(store.state.settings.controlsHideSeconds).toBe(3);
		expect(store.state.settings.hlsBufferSeconds).toBe(120);
		expect(store.state.settings.danmakuOpacity).toBe(0.4);
	});

	it("mutes the old sound default once without changing language or other preferences", async () => {
		const previous = {
			locale: "en",
			volume: 37,
			muted: true,
			sfxEnabled: true,
			sfxVolume: 0.35,
			theme: Theme.deepblue,
			roomLayout: RoomLayoutMode.theater,
			chatOverlaySeconds: 3,
		};
		saved.set("settings", JSON.stringify({ ...previous, defaultLocaleVersion: "v0.15.0-cn3" }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings).toMatchObject({ ...previous, sfxEnabled: false });
		expect(JSON.parse(saved.get("settings")!)).toMatchObject({
			...previous,
			sfxEnabled: false,
			defaultLocaleVersion: "v0.15.0-cn3",
			defaultSfxVersion: "v0.15.0-cn6",
		});
	});

	it.each([
		true,
		false,
	])("preserves a deliberate sound choice across visits: %s", async enabled => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", {
			sfxEnabled: enabled,
			sfxVolume: 0.23,
			locale: "en",
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.sfxEnabled).toBe(enabled);
		expect(nextVisit.state.settings.sfxVolume).toBe(0.23);
		expect(nextVisit.state.settings.locale).toBe("en");
	});

	it.each([null, -1, 2, "0.5"])("rejects damaged saved sound settings: %s", async volume => {
		saved.set(
			"settings",
			JSON.stringify({
				defaultLocaleVersion: "v0.15.0-cn3",
				defaultSfxVersion: "v0.15.0-cn6",
				locale: "en",
				sfxEnabled: "true",
				sfxVolume: volume,
			}),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.sfxEnabled).toBe(false);
		expect(store.state.settings.sfxVolume).toBe(0.8);
		expect(store.state.settings.locale).toBe("en");
	});

	it.each([
		[0.8, 0.4],
		[0.3, 0.4],
	])("moves the shipped danmaku opacity default %s to %s once", async (stored, expected) => {
		saved.set(
			"settings",
			JSON.stringify({
				danmakuOpacity: stored,
				danmakuFontSize: "large",
				volume: 37,
				defaultLocaleVersion: "v0.15.0-cn3",
				defaultSfxVersion: "v0.15.0-cn6",
			}),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.danmakuOpacity).toBe(expected);
		expect(store.state.settings.danmakuFontSize).toBe("large");
		expect(store.state.settings.volume).toBe(37);
	});

	it("keeps a deliberately chosen danmaku opacity across visits", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", { danmakuOpacity: 0.55 });
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.danmakuOpacity).toBe(0.55);
	});

	it("persists viewing preferences across visits, including disabled message overlays", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", {
			chatOverlaySeconds: 0,
			presenceNoticeSeconds: 0,
			seekNoticeSeconds: 2,
			controlsHideSeconds: 10,
			hlsBufferSeconds: 120,
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.chatOverlaySeconds).toBe(0);
		expect(nextVisit.state.settings.presenceNoticeSeconds).toBe(0);
		expect(nextVisit.state.settings.seekNoticeSeconds).toBe(2);
		expect(nextVisit.state.settings.controlsHideSeconds).toBe(10);
		expect(nextVisit.state.settings.hlsBufferSeconds).toBe(120);
	});

	it.each([
		null,
		-1,
		100000,
		"5",
	])("replaces invalid saved viewing durations with safe defaults: %s", async value => {
		saved.set(
			"settings",
			JSON.stringify({
				chatOverlaySeconds: value,
				presenceNoticeSeconds: value,
				seekNoticeSeconds: value,
				controlsHideSeconds: value,
				hlsBufferSeconds: value,
			}),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.chatOverlaySeconds).toBe(5);
		expect(store.state.settings.presenceNoticeSeconds).toBe(3);
		expect(store.state.settings.seekNoticeSeconds).toBe(3);
		expect(store.state.settings.controlsHideSeconds).toBe(3);
		expect(store.state.settings.hlsBufferSeconds).toBe(120);
	});

	it("migrates a returning English visitor while preserving their other settings and storage", async () => {
		const previous = {
			locale: "en",
			volume: 37,
			muted: true,
			audioBoost: 125,
			theme: Theme.deepblue,
			roomLayout: RoomLayoutMode.theater,
			swipeSeekSeconds: 30,
			sfxEnabled: false,
			defaultRoomSettings: { autoSkipSegmentCategories: ["intro"] },
		};
		saved.set("settings", JSON.stringify(previous));
		saved.set("token", "saved-login-token");
		saved.set("chat-draft", "稍后发送");
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings).toMatchObject({ ...previous, locale: "zh-CN" });
		expect(JSON.parse(saved.get("settings")!)).toMatchObject({ ...previous, locale: "zh-CN" });
		expect(vuetify.theme.global.name.value).toBe(Theme.deepblue);
		expect(saved.get("token")).toBe("saved-login-token");
		expect(saved.get("chat-draft")).toBe("稍后发送");
	});

	it("allows a deliberate language selection after migration to survive another visit", async () => {
		saved.set("settings", JSON.stringify({ locale: "en" }));
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		expect(firstVisit.state.settings.locale).toBe("zh-CN");
		firstVisit.commit("settings/UPDATE", { locale: "en", volume: 48 });
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.locale).toBe("en");
		expect(nextVisit.state.settings.volume).toBe(48);
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.locale).toBe("en");
	});

	it("applies the new default when the saved migration version is older", async () => {
		saved.set(
			"settings",
			JSON.stringify({ locale: "en", defaultLocaleVersion: "v0.15.0-cn2" }),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.locale).toBe("zh-CN");
	});

	it.each([
		"invalid-json",
		"null",
		"[]",
		'"en"',
		"17",
	])("loads usable defaults when saved settings are damaged: %s", async value => {
		saved.set("settings", value);
		const store = newStore();
		await expect(store.dispatch("settings/load")).resolves.toBeUndefined();
		expect(store.state.settings.locale).toBe("zh-CN");
		expect(store.state.settings.volume).toBe(100);
	});

	it("recovers an invalid saved locale even when the migration marker is current", async () => {
		saved.set(
			"settings",
			JSON.stringify({ locale: null, defaultLocaleVersion: "v0.15.0-cn3" }),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.locale).toBe("zh-CN");
	});

	it("keeps settings usable when browser storage is blocked", async () => {
		const blocked = () => {
			throw new DOMException("Storage disabled", "SecurityError");
		};
		storage.getItem.mockImplementation(blocked);
		storage.setItem.mockImplementation(blocked);
		const store = newStore();
		await expect(store.dispatch("settings/load")).resolves.toBeUndefined();
		expect(store.state.settings.locale).toBe("zh-CN");
		expect(() => store.commit("settings/UPDATE", { locale: "en" })).not.toThrow();
		expect(store.state.settings.locale).toBe("en");
	});

	it("persists danmaku preferences across visits", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", {
			danmakuEnabled: false,
			danmakuOpacity: 0.5,
			danmakuFontSize: "large",
			danmakuSpeed: 1.5,
			danmakuDisplayArea: "bottom",
			danmakuDensity: "low",
			danmakuBlockScroll: true,
			danmakuBlockColored: true,
			danmakuAntiCollision: false,
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings).toMatchObject({
			danmakuEnabled: false,
			danmakuOpacity: 0.5,
			danmakuFontSize: "large",
			danmakuSpeed: 1.5,
			danmakuDisplayArea: "bottom",
			danmakuDensity: "low",
			danmakuBlockScroll: true,
			danmakuBlockTop: false,
			danmakuBlockBottom: false,
			danmakuBlockColored: true,
			danmakuAntiCollision: false,
		});
	});

	it.each([
		[-1, 0.1],
		[0, 0.1],
		[99, 1],
		["0.5", 1],
		[0.5, 0.5],
	])("clamps a saved danmaku opacity of %s to %s", async (stored, expected) => {
		saved.set("settings", JSON.stringify({ danmakuOpacity: stored }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.danmakuOpacity).toBe(expected);
	});

	it.each([
		["danmakuFontSize", "huge"],
		["danmakuSpeed", 3],
		["danmakuEnabled", "yes"],
		["danmakuBlockTop", null],
		["danmakuDisplayArea", "middle"],
		["danmakuDensity", "huge"],
	])("repairs a damaged danmaku setting: %s", async (key, value) => {
		saved.set("settings", JSON.stringify({ [key]: value }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.danmakuFontSize).toBe("medium");
		expect(store.state.settings.danmakuSpeed).toBe(1);
		expect(store.state.settings.danmakuEnabled).toBe(true);
		expect(store.state.settings.danmakuBlockTop).toBe(false);
		expect(store.state.settings.danmakuDisplayArea).toBe("full");
		expect(store.state.settings.danmakuDensity).toBe("high");
	});

	it("persists the audio and display preferences across visits", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", {
			audioEqPreset: "vocal",
			videoFillMode: "cover",
			videoMirror: true,
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings).toMatchObject({
			audioEqPreset: "vocal",
			videoFillMode: "cover",
			videoMirror: true,
		});
	});

	it.each([
		["audioEqPreset", "loud"],
		["videoFillMode", "stretch"],
		["videoMirror", "yes"],
	])("repairs a damaged audio/display setting: %s", async (key, value) => {
		saved.set("settings", JSON.stringify({ [key]: value }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.audioEqPreset).toBe("off");
		expect(store.state.settings.videoFillMode).toBe("contain");
		expect(store.state.settings.videoMirror).toBe(false);
	});

	it("keeps a transient update out of the saved settings", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", { upscaleMode: "anime4k-quality" });
		expect(JSON.parse(saved.get("settings")!)).toMatchObject({
			upscaleMode: "anime4k-quality",
		});

		// The auto-degrade ladder commits this way: the correction applies to this session,
		// and the user's own choice is what the next visit starts from.
		firstVisit.commit("settings/UPDATE_TRANSIENT", {
			upscaleMode: "sharpen",
			upscaleScale: 1.5,
		});
		expect(firstVisit.state.settings.upscaleMode).toBe("sharpen");
		expect(firstVisit.state.settings.upscaleScale).toBe(1.5);
		expect(JSON.parse(saved.get("settings")!)).toMatchObject({
			upscaleMode: "anime4k-quality",
			upscaleScale: "auto",
		});

		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.upscaleMode).toBe("anime4k-quality");
		expect(nextVisit.state.settings.upscaleScale).toBe("auto");
	});

	it("does not mark a migration saved if storage rejects the settings write", async () => {
		saved.set("settings", JSON.stringify({ locale: "en", volume: 37 }));
		storage.setItem.mockImplementation(() => {
			throw new DOMException("Storage full", "QuotaExceededError");
		});
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		expect(firstVisit.state.settings.locale).toBe("zh-CN");
		expect(JSON.parse(saved.get("settings")!)).toEqual({ locale: "en", volume: 37 });
		storage.setItem.mockImplementation((key: string, value: string) => saved.set(key, value));
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.locale).toBe("zh-CN");
		expect(nextVisit.state.settings.volume).toBe(37);
		expect(JSON.parse(saved.get("settings")!)).toMatchObject({
			locale: "zh-CN",
			defaultLocaleVersion: "v0.15.0-cn3",
		});
	});
});
