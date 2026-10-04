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

	it("leaves the enhancement off by default on every device", async () => {
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(store.state.settings.upscaleStrength).toBe(DEFAULT_UPSCALE_STRENGTH);
	});

	it("turns the machine-set phone default back off once", async () => {
		// The early phone default stored exactly this pair; it was never a choice.
		saved.set(
			"settings",
			JSON.stringify({
				upscaleMode: "sharpen",
				upscaleStrength: PHONE_UPSCALE_STRENGTH,
			}),
		);
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(store.state.settings.upscaleStrength).toBe(DEFAULT_UPSCALE_STRENGTH);
	});

	it("keeps any tier the visitor picked, even at the old phone strength", async () => {
		// Only the exact machine-set value is moved; everything else is a choice.
		saved.set("settings", JSON.stringify({ upscaleMode: "sharpen", upscaleStrength: 1.1 }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("sharpen");
		expect(store.state.settings.upscaleStrength).toBe(1.1);
	});

	it("never overrides a tier the visitor already picked, including off", async () => {
		saved.set("settings", JSON.stringify({ upscaleMode: "off", upscaleStrength: 1.2 }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(store.state.settings.upscaleStrength).toBe(1.2);
	});

	it("migrates a session only once", async () => {
		saved.set(
			"settings",
			JSON.stringify({ upscaleMode: "sharpen", upscaleStrength: PHONE_UPSCALE_STRENGTH }),
		);
		const firstVisit = newStore();
		await firstVisit.dispatch("settings/load");
		expect(firstVisit.state.settings.upscaleMode).toBe("off");
		// The marker is stored now, so picking the tier again at the same strength sticks.
		firstVisit.commit("settings/UPDATE", {
			upscaleMode: "sharpen",
			upscaleStrength: PHONE_UPSCALE_STRENGTH,
		});
		const nextVisit = newStore();
		await nextVisit.dispatch("settings/load");
		expect(nextVisit.state.settings.upscaleMode).toBe("sharpen");
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
		2.2,
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
		for (const scale of [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, "auto"] as const) {
			const store = newStore();
			await store.dispatch("settings/load");
			store.commit("settings/UPDATE", { upscaleScale: scale });
			expect(store.state.settings.upscaleScale).toBe(scale);
		}
	});

	it("persists every enhancement mode, including the heavy AI tier", async () => {
		// The degrade ladder also writes anime4k when the quality tier gives way, so
		// every value it can produce has to survive a reload.
		for (const mode of ["sharpen", "film", "anime4k", "anime4k-quality"] as const) {
			saved.clear();
			const first = newStore();
			await first.dispatch("settings/load");
			first.commit("settings/UPDATE", { upscaleMode: mode });
			const next = newStore();
			await next.dispatch("settings/load");
			expect(next.state.settings.upscaleMode).toBe(mode);
		}
	});

	it.each(["anime4k-extreme", 3, null])("rejects a damaged saved mode: %s", async upscaleMode => {
		saved.set("settings", JSON.stringify({ upscaleMode }));
		const store = newStore();
		await store.dispatch("settings/load");
		expect(store.state.settings.upscaleMode).toBe("off");
	});
});
