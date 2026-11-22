import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref, shallowRef } from "vue";
import { VCheckbox, VSelect, VSlider } from "vuetify/components";
import VideoSettings from "@/components/controls/VideoSettings.vue";
import { useMediaPlayer, type MediaPlayer } from "@/components/composables";
import { UPSCALE_MODES } from "@/stores/settings";
import { mountComponent } from "./component-test-utils";

const adapterState = vi.hoisted(() => ({
	current: { class: "unknown", renderer: null } as {
		class: "discrete" | "integrated" | "unknown";
		renderer: string | null;
	},
}));
vi.mock("@/util/upscale/adapter", async importOriginal => {
	const actual = await importOriginal<typeof import("@/util/upscale/adapter")>();
	return { ...actual, probeAdapter: () => adapterState.current };
});

const Harness = defineComponent({
	components: { VideoSettings },
	setup() {
		return { controls: useMediaPlayer() };
	},
	template: "<VideoSettings />",
});

describe("video enhancement source support", () => {
	let controls: ReturnType<typeof useMediaPlayer> | undefined;
	let saved: Map<string, string>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		saved = new Map();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, value),
		});
	});

	afterEach(() => {
		controls?.setPlayer(null);
		controls = undefined;
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function settle() {
		await nextTick();
		await vi.advanceTimersByTimeAsync(100);
		await nextTick();
	}

	async function mountSettings(supported?: boolean) {
		const page = mountComponent(Harness);
		controls = (page.wrapper.vm as unknown as { controls: ReturnType<typeof useMediaPlayer> })
			.controls;
		const allowed = ref(supported === true);
		const video = shallowRef(document.createElement("video"));
		video.value.crossOrigin = "anonymous";
		const player: MediaPlayer & { isVideoEnhancementSupported?: () => boolean } = {
			play: vi.fn(),
			pause: vi.fn(),
			setVolume: vi.fn(),
			getPosition: () => 0,
			setPosition: vi.fn(),
			getVideoElement: () => (supported === undefined ? undefined : video.value),
			isCaptionsSupported: () => false,
			isQualitySupported: () => false,
			getAvailablePlaybackRates: () => [1],
		};
		if (supported !== undefined) {
			player.isVideoEnhancementSupported = () => allowed.value;
		}
		controls.setPlayer(player);
		controls.markApiReady();
		page.store.commit("settings/UPDATE", { upscaleMode: "film" });
		await settle();
		await page.wrapper.get('[data-cy="player-settings-toggle"]').trigger("click");
		await settle();
		return { ...page, allowed, video };
	}

	async function openEnhancement() {
		document.querySelector<HTMLElement>('[data-cy="player-upscale-toggle"]')!.click();
		await settle();
	}

	it.each([
		["iframe", undefined],
		["native source without CORS", false],
	] as const)("explains why a %s cannot enhance and preserves the preference", async (_kind, supported) => {
		const { wrapper, store } = await mountSettings(supported);
		expect(document.querySelector('[data-cy="player-upscale-toggle"]')!.textContent).toContain(
			"当前片源不支持",
		);
		await openEnhancement();
		expect(
			document.querySelector('[data-cy="upscale-source-unavailable"]')!.textContent,
		).toContain("保留");
		for (const mode of UPSCALE_MODES.filter(mode => mode !== "off")) {
			const button = document.querySelector<HTMLButtonElement>(
				`[data-cy="upscale-tier-${mode}"]`,
			)!;
			expect(button.disabled).toBe(true);
			button.click();
		}
		expect(wrapper.getComponent(VSlider).props("disabled")).toBe(true);
		expect(wrapper.getComponent(VSelect).props("disabled")).toBe(true);
		expect(wrapper.getComponent(VCheckbox).props("disabled")).toBe(true);
		expect(store.state.settings.upscaleMode).toBe("film");
		expect(JSON.parse(saved.get("settings")!).upscaleMode).toBe("film");
	});

	it("updates the menu when a live CORS fallback keeps the same video element", async () => {
		const { wrapper, store, allowed, video } = await mountSettings(true);
		await openEnhancement();
		const originalVideo = video.value;
		const sharpen = document.querySelector<HTMLButtonElement>(
			'[data-cy="upscale-tier-sharpen"]',
		)!;
		expect(sharpen.disabled).toBe(false);
		sharpen.click();
		await settle();
		expect(store.state.settings.upscaleMode).toBe("sharpen");
		expect(wrapper.getComponent(VSlider).props("disabled")).toBe(false);
		allowed.value = false;
		video.value.removeAttribute("crossorigin");
		await settle();
		expect(video.value).toBe(originalVideo);
		expect(sharpen.disabled).toBe(true);
		expect(wrapper.getComponent(VSelect).props("disabled")).toBe(true);
		expect(JSON.parse(saved.get("settings")!).upscaleMode).toBe("sharpen");
		allowed.value = true;
		await settle();
		expect(sharpen.disabled).toBe(false);
		expect(store.state.settings.upscaleMode).toBe("sharpen");
	});

	it("lets the viewer turn off the saved enhancement on an unsupported source", async () => {
		const { store } = await mountSettings(false);
		await openEnhancement();
		const off = document.querySelector<HTMLButtonElement>('[data-cy="upscale-tier-off"]')!;
		expect(off.disabled).toBe(false);
		off.click();
		await settle();
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(JSON.parse(saved.get("settings")!).upscaleMode).toBe("off");
	});

	it("warns that a heavy tier runs on the integrated GPU and offers the tier that fits", async () => {
		// The reported cause of "the AI tier crawls" on a hybrid laptop: the browser renders on
		// the iGPU and nothing in the page can move it. Say so, and offer the tier that fits,
		// instead of hiding tiers — hiding them is what broke this menu in v1.2.x.
		adapterState.current = {
			class: "integrated",
			renderer: "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0)",
		};
		const { store } = await mountSettings(true);
		store.commit("settings/UPDATE", { upscaleMode: "anime4k-quality" });
		await settle();
		await openEnhancement();

		const note = document.querySelector('[data-cy="upscale-integrated-gpu"]')!;
		expect(note.textContent).toContain("核显");
		expect(note.textContent).toContain("Intel(R) UHD Graphics");
		const useSharpen = note.querySelector<HTMLButtonElement>(
			'[data-cy="upscale-use-sharpen"]',
		)!;
		useSharpen.click();
		await settle();

		expect(store.state.settings.upscaleMode).toBe("sharpen");
		expect(document.querySelector('[data-cy="upscale-integrated-gpu"]')).toBeNull();
	});

	it("does not warn on a discrete GPU, or on a light tier", async () => {
		adapterState.current = {
			class: "discrete",
			renderer:
				"ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0)",
		};
		const { store } = await mountSettings(true);
		store.commit("settings/UPDATE", { upscaleMode: "anime4k-ultra" });
		await settle();
		await openEnhancement();
		expect(document.querySelector('[data-cy="upscale-integrated-gpu"]')).toBeNull();

		adapterState.current = {
			class: "integrated",
			renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)",
		};
		store.commit("settings/UPDATE", { upscaleMode: "sharpen" });
		await settle();
		expect(document.querySelector('[data-cy="upscale-integrated-gpu"]')).toBeNull();
	});
});
