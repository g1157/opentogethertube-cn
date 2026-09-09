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
			sfxEnabled: false,
		});
		expect(store.state.settings).not.toHaveProperty("defaultLocaleVersion");
		expect(store.state.settings).not.toHaveProperty("defaultSfxVersion");
		expect(store.state.settings.sfxEnabled).toBe(false);
		expect(store.state.settings.chatOverlaySeconds).toBe(5);
		expect(store.state.settings.controlsHideSeconds).toBe(3);
		expect(store.state.settings.hlsBufferSeconds).toBe(60);
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

	it("persists viewing preferences across visits, including disabled message overlays", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", {
			chatOverlaySeconds: 0,
			controlsHideSeconds: 10,
			hlsBufferSeconds: 120,
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.chatOverlaySeconds).toBe(0);
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
				controlsHideSeconds: value,
				hlsBufferSeconds: value,
			}),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.chatOverlaySeconds).toBe(5);
		expect(store.state.settings.controlsHideSeconds).toBe(3);
		expect(store.state.settings.hlsBufferSeconds).toBe(60);
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
