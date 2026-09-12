import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "vuex";
import vuetify from "@/plugins/vuetify";
import {
	DEFAULT_UPSCALE_STRENGTH,
	PHONE_UPSCALE_STRENGTH,
	settingsModule,
	type SettingsState,
	Theme,
} from "@/stores/settings";
import { PHONE_MAX_QUERY } from "@/util/breakpoints";

function stubViewport(matches: (query: string) => boolean) {
	vi.stubGlobal("matchMedia", (query: string) => {
		const media = new EventTarget();
		Object.defineProperties(media, {
			media: { value: query },
			matches: { get: () => matches(query) },
		});
		return media;
	});
}

describe("video enhancement settings", () => {
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

	it("defaults to the automatic render size and keeps stepping down if measured slow", async () => {
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleStrength).toBe(DEFAULT_UPSCALE_STRENGTH);
		expect(store.state.settings.upscaleScale).toBe("auto");
		expect(store.state.settings.upscaleAutoDegrade).toBe(true);
	});

	it("starts phones on the light tier so the first run is not a stutter", async () => {
		stubViewport(query => query === PHONE_MAX_QUERY);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("sharpen");
		expect(store.state.settings.upscaleStrength).toBe(PHONE_UPSCALE_STRENGTH);
	});

	it("leaves desktops off by default", async () => {
		stubViewport(() => false);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(store.state.settings.upscaleStrength).toBe(DEFAULT_UPSCALE_STRENGTH);
	});

	it("still loads when the environment has no matchMedia", async () => {
		// jsdom does not implement it; the module must not depend on it existing.
		const store = newStore();
		await expect(store.dispatch("settings/load")).resolves.toBeUndefined();
		expect(store.state.settings.upscaleMode).toBe("off");
	});

	it("never overrides a tier the visitor already picked, including off", async () => {
		stubViewport(query => query === PHONE_MAX_QUERY);
		saved.set("settings", JSON.stringify({ upscaleMode: "off", upscaleStrength: 1.2 }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(store.state.settings.upscaleStrength).toBe(1.2);
	});

	it("does not re-apply the phone default on later visits", async () => {
		stubViewport(query => query === PHONE_MAX_QUERY);
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		expect(firstVisit.state.settings.upscaleMode).toBe("sharpen");
		firstVisit.commit("settings/UPDATE", { upscaleMode: "off" });
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.upscaleMode).toBe("off");
	});

	it("persists deliberate enhancement choices across visits", async () => {
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		firstVisit.commit("settings/UPDATE", {
			upscaleMode: "sharpen",
			upscaleStrength: 1.1,
			upscaleScale: 0.5,
			upscaleAutoDegrade: false,
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.upscaleMode).toBe("sharpen");
		expect(nextVisit.state.settings.upscaleStrength).toBe(1.1);
		expect(nextVisit.state.settings.upscaleScale).toBe(0.5);
		expect(nextVisit.state.settings.upscaleAutoDegrade).toBe(false);
	});

	it.each([
		null,
		-1,
		5,
		"0.5",
		Number.NaN,
	])("rejects a damaged saved strength: %s", async strength => {
		saved.set("settings", JSON.stringify({ upscaleStrength: strength }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleStrength).toBe(DEFAULT_UPSCALE_STRENGTH);
	});

	it.each([
		3,
		"3",
		null,
		"huge",
	])("rejects a damaged saved render scale: %s", async upscaleScale => {
		saved.set("settings", JSON.stringify({ upscaleScale }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleScale).toBe("auto");
	});

	it.each([
		"yes",
		1,
		null,
	])("rejects a damaged saved auto-degrade flag: %s", async upscaleAutoDegrade => {
		saved.set("settings", JSON.stringify({ upscaleAutoDegrade }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleAutoDegrade).toBe(true);
	});

	it("accepts every scale the degrade ladder can store", async () => {
		// The ladder writes these directly; a value it cannot read back would be reset
		// to "auto" and the step would silently do nothing.
		for (const scale of [0.25, 0.5, 0.75, 1, 1.5, 2, "auto"] as const) {
			const store = newStore();
			await store.dispatch("settings/load");
			store.commit("settings/UPDATE", { upscaleScale: scale });
			expect(store.state.settings.upscaleScale).toBe(scale);
		}
	});
});
