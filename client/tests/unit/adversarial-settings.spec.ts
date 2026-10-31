import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "vuex";
import vuetify from "@/plugins/vuetify";
import { RoomLayoutMode, settingsModule, Theme, type SettingsState } from "@/stores/settings";
import {
	getOneWayDelayMs,
	noteLatencySample,
	resetLatencySamples,
} from "@/util/connection-latency";

describe("corrupted persisted settings", () => {
	let saved: Map<string, string>;
	const newStore = () =>
		createStore<{ settings: SettingsState }>({ modules: { settings: settingsModule } });

	beforeEach(() => {
		saved = new Map();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vuetify.theme.global.name.value = Theme.teal;
	});

	it("normalizes out-of-range and wrong-typed values instead of trusting storage", async () => {
		saved.set(
			"settings",
			JSON.stringify({
				volume: "loud",
				muted: "yes",
				audioBoost: 1e9,
				roomLayout: "bogus",
				theme: "bogus",
				enableAdapterSelector: "yes",
				sfxVolume: 99,
				danmakuOpacity: 99,
				upscaleStrength: 1e9,
				hlsBufferSeconds: 1e9,
				seriesProbeLimit: 1e9,
				danmakuApiBase: 42,
				notesPanelOpen: "yes",
			}),
		);

		const store = newStore();
		await store.dispatch("settings/load");
		const state = store.state.settings;

		expect(state.volume).toBe(100);
		expect(state.muted).toBe(false);
		expect(state.audioBoost).toBe(300);
		expect(state.roomLayout).toBe(RoomLayoutMode.default);
		expect(state.theme).toBe(Theme.teal);
		expect(state.enableAdapterSelector).toBe(false);
		expect(state.sfxVolume).toBe(0.8);
		expect(state.danmakuOpacity).toBe(1);
		expect(state.upscaleStrength).toBeLessThanOrEqual(2);
		expect(state.hlsBufferSeconds).toBe(300);
		expect(state.danmakuApiBase).toBe("");
		expect(state.notesPanelOpen).toBe(true);
	});

	it("survives invalid JSON and arrays in storage", async () => {
		for (const value of ["not json", "[]", "null", '"string"', "42"]) {
			saved.set("settings", value);
			const store = newStore();
			await expect(store.dispatch("settings/load")).resolves.toBeUndefined();
			expect(Number.isFinite(store.state.settings.volume)).toBe(true);
			expect(store.state.settings.volume).toBe(100);
		}
	});

	it("keeps a valid but unusual choice", async () => {
		saved.set(
			"settings",
			JSON.stringify({
				volume: 0,
				muted: true,
				audioBoost: 150,
				roomLayout: RoomLayoutMode.theater,
				theme: Theme.oled,
			}),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.volume).toBe(0);
		expect(store.state.settings.muted).toBe(true);
		expect(store.state.settings.audioBoost).toBe(150);
		expect(store.state.settings.roomLayout).toBe(RoomLayoutMode.theater);
		expect(store.state.settings.theme).toBe(Theme.oled);
	});
});

describe("latency sample boundary", () => {
	beforeEach(() => resetLatencySamples());

	it("ignores non-finite, negative and implausible samples", () => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			-1,
			5001,
		]) {
			noteLatencySample(value, 1000);
		}
		expect(getOneWayDelayMs(1000)).toBe(0);

		noteLatencySample(100, 1000);
		expect(getOneWayDelayMs(1000)).toBe(50);
	});

	it("uses the smallest recent sample and expires stale samples", () => {
		noteLatencySample(400, 1000);
		noteLatencySample(100, 1001);
		noteLatencySample(300, 1002);
		expect(getOneWayDelayMs(1002)).toBe(50);
		expect(getOneWayDelayMs(1002 + 180_001)).toBe(0);
	});
});
