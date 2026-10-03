import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, defineComponent, nextTick, ref } from "vue";
import { VMenu } from "vuetify/components";
import { RoomRequestType } from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import VideoSettings from "@/components/controls/VideoSettings.vue";
import VideoControls from "@/components/controls/VideoControls.vue";
import BasicControls from "@/components/controls/BasicControls.vue";
import PlaybackRateSwitcher from "@/components/controls/PlaybackRateSwitcher.vue";
import LayoutSwitcher from "@/components/controls/LayoutSwitcher.vue";
import ClosedCaptionsSwitcher from "@/components/controls/ClosedCaptionsSwitcher.vue";
import {
	useCaptions,
	useMediaPlayer,
	usePlaybackRate,
	useQualities,
} from "@/components/composables";
import type { MediaPlayer } from "@/components/composables";
import { useStore } from "@/store";
import { PlayerFullscreenKey } from "@/util/player-fullscreen";
import { mountComponent } from "./component-test-utils";

type MenuKind = "settings" | "rate";
const selectors: Record<MenuKind, string> = {
	settings: '[data-cy="player-settings-toggle"]',
	rate: '[data-cy="playback-rate-toggle"]',
};
const MAX_WIDTH_QUERY = /max-width:\s*(\d+)px/;

function rectangle(x: number, y: number, width: number, height: number): DOMRect {
	return {
		x,
		y,
		width,
		height,
		left: x,
		top: y,
		right: x + width,
		bottom: y + height,
		toJSON: () => ({ x, y, width, height }),
	};
}

class TestViewport extends EventTarget {
	width = 320;
	height = 568;
	scale = 1;
	offsetLeft = 0;
	offsetTop = 0;
}

class TestResizeObserver {
	static instances = new Set<TestResizeObserver>();
	readonly targets = new Set<Element>();
	constructor(private callback: ResizeObserverCallback) {
		TestResizeObserver.instances.add(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		TestResizeObserver.instances.delete(this);
	}
	static resize(target: Element) {
		for (const observer of Array.from(TestResizeObserver.instances)) {
			if (observer.targets.has(target)) {
				observer.callback(
					[{ target } as ResizeObserverEntry],
					observer as unknown as ResizeObserver,
				);
			}
		}
	}
}

function menuHarness(kind: MenuKind) {
	return defineComponent({
		components: { VideoSettings, PlaybackRateSwitcher },
		setup() {
			const store = useStore();
			const controls = useMediaPlayer();
			const player = ref<HTMLElement | null>(null);
			const defaults = computed(() => ({
				VMenu: { attach: store.state.fullscreen ? player.value : false },
				VTooltip: { attach: store.state.fullscreen ? player.value : false },
			}));
			return { player, defaults, store, controls };
		},
		template: `<div ref="player" class="player-menu-host" :class="{ 'player-fullscreen': store.state.fullscreen }" :style="{ position: store.state.fullscreen ? 'fixed' : 'relative' }">
			<v-defaults-provider :defaults="defaults">
				${kind === "settings" ? "<VideoSettings />" : "<PlaybackRateSwitcher />"}
			</v-defaults-provider>
		</div>`,
	});
}

describe("player menu placement", () => {
	let page: ReturnType<typeof mountComponent> | undefined;
	let menuControls: ReturnType<typeof useMediaPlayer> | undefined;
	let viewport: TestViewport;
	let buttonRect: DOMRect;
	let menuHeight: number;
	let hover: boolean;
	let mediaQueries: Set<EventTarget>;

	beforeEach(() => {
		vi.useFakeTimers();
		viewport = new TestViewport();
		buttonRect = rectangle(250, 420, 48, 48);
		menuHeight = 250;
		hover = false;
		mediaQueries = new Set();
		vi.stubGlobal("visualViewport", viewport);
		vi.stubGlobal("innerWidth", viewport.width);
		vi.stubGlobal("innerHeight", viewport.height);
		vi.stubGlobal("ResizeObserver", TestResizeObserver);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
			window.setTimeout(() => callback(performance.now()), 16),
		);
		vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
		vi.stubGlobal("matchMedia", (query: string) => {
			const media = new EventTarget();
			Object.defineProperties(media, {
				media: { value: query },
				matches: {
					get: () => {
						const width = MAX_WIDTH_QUERY.exec(query);
						if (query.includes("orientation: portrait")) {
							return (
								!!width &&
								viewport.width <= Number(width[1]) &&
								viewport.height > viewport.width
							);
						}
						return width ? viewport.width <= Number(width[1]) : hover;
					},
				},
			});
			mediaQueries.add(media);
			return media as unknown as MediaQueryList;
		});

		const originalRect = HTMLElement.prototype.getBoundingClientRect;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
			this: HTMLElement,
		) {
			if (this.matches(Object.values(selectors).join(","))) {
				return buttonRect;
			}
			if (this.classList.contains("v-overlay__content")) {
				const width = this.querySelector(".playback-rate-menu") ? 160 : 320;
				return rectangle(
					Number.parseFloat(this.style.left) || 0,
					Number.parseFloat(this.style.top) || 0,
					Math.min(width, Number.parseFloat(this.style.maxWidth) || width),
					Math.min(menuHeight, Number.parseFloat(this.style.maxHeight) || menuHeight),
				);
			}
			return originalRect.call(this);
		});
		const originalClientRects = HTMLElement.prototype.getClientRects;
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
			this: HTMLElement,
		) {
			if (this.matches(Object.values(selectors).join(","))) {
				return [buttonRect] as unknown as DOMRectList;
			}
			return originalClientRects.call(this);
		});

		usePlaybackRate().availablePlaybackRates.value = [0.5, 1, 1.5, 2];
		usePlaybackRate().playbackRate.value = 1;
		const qualities = useQualities();
		qualities.isQualitySupported.value = true;
		qualities.isAutoQualitySupported.value = false;
		qualities.videoTracks.value = [
			{ width: 1280, height: 720 },
			{ width: 1920, height: 1080 },
		];
		qualities.currentVideoTrack.value = 0;
		useCaptions().isCaptionsSupported.value = true;
		useCaptions().captionsTracks.value = [{ label: "简体中文", srclang: "zh-CN" }];
	});

	afterEach(() => {
		menuControls?.setPlayer(null);
		menuControls = undefined;
		page?.wrapper.unmount();
		page = undefined;
		TestResizeObserver.instances.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function settle() {
		await nextTick();
		await vi.advanceTimersByTimeAsync(100);
		await nextTick();
	}

	async function mountMenu(kind: MenuKind) {
		page = mountComponent(menuHarness(kind), {
			global: { stubs: { transition: false } },
		});
		page.connection.connected.value = true;
		page.store.state.room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.speed"]);
		page.store.commit("users/SET_YOU", { info: { id: "menu-user" } });
		page.store.commit("users/INIT_USERS", [
			{
				id: "menu-user",
				name: "Menu user",
				role: Role.UnregisteredUser,
				isLoggedIn: false,
				status: PlayerStatus.ready,
			},
		]);
		await settle();
		return page;
	}

	function menuContent() {
		const element = document.querySelector<HTMLElement>(
			".v-menu.v-overlay--active .v-overlay__content",
		);
		expect(element).not.toBeNull();
		return element!;
	}

	function expectInViewport(content: HTMLElement) {
		const rect = content.getBoundingClientRect();
		expect(rect.width).toBeGreaterThan(0);
		expect(rect.height).toBeGreaterThan(0);
		expect(rect.left).toBeGreaterThanOrEqual(viewport.offsetLeft + 12);
		expect(rect.top).toBeGreaterThanOrEqual(viewport.offsetTop + 12);
		expect(rect.right).toBeLessThanOrEqual(viewport.offsetLeft + viewport.width - 12);
		expect(rect.bottom).toBeLessThanOrEqual(viewport.offsetTop + viewport.height - 12);
	}

	it.each([
		"settings",
		"rate",
	] as const)("anchors the %s menu to its button and repositions within a narrow viewport on rotation", async kind => {
		const { wrapper } = await mountMenu(kind);
		const button = wrapper.get(selectors[kind]);
		await button.trigger("click");
		await settle();

		const menu = wrapper.getComponent(VMenu).vm as unknown as { activatorEl: HTMLElement };
		expect(menu.activatorEl).toBe(button.element);
		expect(button.attributes("aria-expanded")).toBe("true");
		const content = menuContent();
		expectInViewport(content);
		const previousLeft = content.style.left;

		viewport.width = 640;
		viewport.height = 320;
		buttonRect = rectangle(560, 240, 48, 48);
		window.dispatchEvent(new Event("resize"));
		viewport.dispatchEvent(new Event("resize"));
		await settle();
		// Expanding max-width changes the rendered menu width; browsers then deliver
		// its ResizeObserver notification before painting the corrected placement.
		TestResizeObserver.resize(content);
		await settle();

		expect(content.style.left).not.toBe(previousLeft);
		expectInViewport(content);
	});

	it.each([
		"settings",
		"rate",
	] as const)("closes the %s menu across fullscreen changes and reopens inside the player attachment", async kind => {
		const { wrapper, store } = await mountMenu(kind);
		const button = wrapper.get(selectors[kind]);
		const player = wrapper.get(".player-menu-host").element;
		await button.trigger("click");
		await settle();
		expect(player.contains(menuContent())).toBe(false);

		store.commit("SET_FULLSCREEN", true);
		await settle();
		expect(button.attributes("aria-expanded")).toBe("false");
		expect(document.querySelector(".v-menu.v-overlay--active")).toBeNull();

		await button.trigger("click");
		await settle();
		expect(player.contains(menuContent())).toBe(true);
		expectInViewport(menuContent());

		store.commit("SET_FULLSCREEN", false);
		await settle();
		expect(button.attributes("aria-expanded")).toBe("false");
		expect(document.querySelector(".v-menu.v-overlay--active")).toBeNull();
	});

	it("keeps a taller settings submenu inside the viewport when its contents change", async () => {
		menuHeight = 160;
		const { wrapper } = await mountMenu("settings");
		await wrapper.get(selectors.settings).trigger("click");
		await settle();
		const content = menuContent();
		const previousTop = content.style.top;
		menuHeight = 560;
		document.querySelector<HTMLElement>('[data-cy="player-upscale-toggle"]')!.click();
		await settle();
		TestResizeObserver.resize(content);
		await settle();

		expect(content.textContent).toContain("清晰化");
		expect(content.style.top).not.toBe(previousTop);
		expectInViewport(content);
	});

	it("offers audio presets from the player menu and commits the choice", async () => {
		const { wrapper, store } = await mountMenu("settings");
		menuControls = (wrapper.vm as unknown as { controls: ReturnType<typeof useMediaPlayer> })
			.controls;
		menuControls.setPlayer({
			setAudioBoost: vi.fn(),
			setAudioEq: vi.fn(),
		} as unknown as MediaPlayer);
		menuControls.markApiReady();
		await settle();

		await wrapper.get(selectors.settings).trigger("click");
		await settle();
		document.querySelector<HTMLElement>('[data-cy="player-audio-toggle"]')!.click();
		await settle();

		const bass = document.querySelector<HTMLElement>('[data-cy="audio-eq-bass"]');
		expect(bass).not.toBeNull();
		bass!.click();
		await settle();

		expect(store.state.settings.audioEqPreset).toBe("bass");
	});

	it("labels the option rows of the audio and display submenus", async () => {
		// Regression: the option list was built with a `title` field while the rows read
		// `text`, which left both submenus showing blank, apparently transparent rows.
		const { wrapper } = await mountMenu("settings");
		menuControls = (wrapper.vm as unknown as { controls: ReturnType<typeof useMediaPlayer> })
			.controls;
		menuControls.setPlayer({
			setAudioBoost: vi.fn(),
			setAudioEq: vi.fn(),
		} as unknown as MediaPlayer);
		menuControls.markApiReady();
		await settle();

		await wrapper.get(selectors.settings).trigger("click");
		await settle();
		document.querySelector<HTMLElement>('[data-cy="player-audio-toggle"]')!.click();
		await settle();
		expect(
			document.querySelector<HTMLElement>('[data-cy="audio-eq-bass"]')!.textContent,
		).toContain("低音增强");

		document.querySelector<HTMLElement>(".settings-menu-container .menu-header")!.click();
		await settle();
		document.querySelector<HTMLElement>('[data-cy="player-display-toggle"]')!.click();
		await settle();
		expect(
			document.querySelector<HTMLElement>('[data-cy="video-fill-cover"]')!.textContent,
		).toContain("铺满");
	});

	it("keeps the enhancement entry in the main menu and the preferences in 更多设置", async () => {
		const { wrapper } = await mountMenu("settings");
		await wrapper.get(selectors.settings).trigger("click");
		await settle();

		document.querySelector<HTMLElement>('[data-cy="player-upscale-toggle"]')!.click();
		await settle();
		expect(document.querySelector('[data-cy="upscale-tiers"]')).not.toBeNull();

		document.querySelector<HTMLElement>(".settings-menu-container .menu-header")!.click();
		await settle();
		expect(document.querySelector('[data-cy="player-more-toggle"]')).not.toBeNull();
		document.querySelector<HTMLElement>('[data-cy="player-more-toggle"]')!.click();
		await settle();
		expect(document.querySelector('[data-cy="player-preferences-toggle"]')).not.toBeNull();
	});

	it("offers picture fitting from the player menu", async () => {
		const { wrapper, store } = await mountMenu("settings");
		menuControls = (wrapper.vm as unknown as { controls: ReturnType<typeof useMediaPlayer> })
			.controls;
		menuControls.setPlayer({
			setAudioBoost: vi.fn(),
			setAudioEq: vi.fn(),
		} as unknown as MediaPlayer);
		menuControls.markApiReady();
		await settle();

		await wrapper.get(selectors.settings).trigger("click");
		await settle();
		document.querySelector<HTMLElement>('[data-cy="player-display-toggle"]')!.click();
		await settle();

		document.querySelector<HTMLElement>('[data-cy="video-fill-cover"]')!.click();
		await settle();
		expect(store.state.settings.videoFillMode).toBe("cover");

		document.querySelector<HTMLInputElement>('[data-cy="video-mirror"] input')!.click();
		await settle();
		expect(store.state.settings.videoMirror).toBe(true);
	});

	it("selects playback speed once and closes the connected menu", async () => {
		const { wrapper, connection } = await mountMenu("rate");
		await wrapper.get(selectors.rate).trigger("click");
		await settle();
		const choices = document.querySelectorAll<HTMLElement>(".playback-rate-menu .v-list-item");
		choices[3].click();
		await settle();

		expect(connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.PlaybackSpeedRequest, speed: 2 } },
		]);
		expect(wrapper.get(selectors.rate).attributes("aria-expanded")).toBe("false");
	});

	it("changes viewing preferences immediately from the fullscreen player menu", async () => {
		const { wrapper, store } = await mountMenu("settings");
		store.commit("SET_FULLSCREEN", true);
		await settle();
		await wrapper.get(selectors.settings).trigger("click");
		await settle();
		document.querySelector<HTMLElement>('[data-cy="player-more-toggle"]')!.click();
		await settle();
		document.querySelector<HTMLElement>('[data-cy="player-preferences-toggle"]')!.click();
		await settle();

		const player = wrapper.get(".player-menu-host").element;
		const soundToggle = document.querySelector<HTMLInputElement>(
			'[data-cy="chat-sound-enabled"] input',
		)!;
		expect(player.contains(soundToggle)).toBe(true);
		expect(soundToggle.checked).toBe(false);
		store.commit("settings/UPDATE", { volume: 37, muted: true });
		soundToggle.click();
		await settle();
		expect(store.state.settings.sfxEnabled).toBe(true);
		soundToggle.click();
		await settle();
		expect(store.state.settings.sfxEnabled).toBe(false);
		expect(store.state.settings.volume).toBe(37);
		expect(store.state.settings.muted).toBe(true);
		expect(wrapper.get(selectors.settings).attributes("aria-expanded")).toBe("true");
		const chatChips = document.querySelector<HTMLElement>('[data-cy="chat-overlay-duration"]')!;
		expect(
			[...chatChips.querySelectorAll(".v-btn")].map(btn => btn.textContent?.trim()),
		).toEqual(["关", "3 秒", "5 秒", "10 秒", "20 秒"]);
		expect(player.contains(chatChips)).toBe(true);
		chatChips.querySelectorAll<HTMLElement>(".v-btn")[0].click();
		await settle();
		expect(store.state.settings.chatOverlaySeconds).toBe(0);
		expect(wrapper.get(selectors.settings).attributes("aria-expanded")).toBe("true");

		const controlsChips = document.querySelector<HTMLElement>(
			'[data-cy="controls-hide-delay"]',
		)!;
		[...controlsChips.querySelectorAll<HTMLElement>(".v-btn")]
			.find(btn => btn.textContent?.trim() === "10 秒")!
			.click();
		await settle();
		expect(store.state.settings.controlsHideSeconds).toBe(10);
		for (const [selector, title, setting, value] of [
			["presence-notice-duration", "关", "presenceNoticeSeconds", 0],
			["seek-notice-duration", "2 秒", "seekNoticeSeconds", 2],
		] as const) {
			const chips = document.querySelector<HTMLElement>(`[data-cy="${selector}"]`)!;
			[...chips.querySelectorAll<HTMLElement>(".v-btn")]
				.find(btn => btn.textContent?.trim() === title)!
				.click();
			await settle();
			expect(store.state.settings[setting]).toBe(value);
		}
	});

	it("switches quality and subtitles from the control bar", async () => {
		viewport.width = 1280;
		viewport.height = 720;
		page = mountComponent(VideoControls, {
			props: {
				sliderPosition: 100,
				truePosition: 100,
				controlsVisible: true,
				mode: "in-video",
			},
			global: { provide: { [PlayerFullscreenKey as symbol]: { toggle: vi.fn() } } },
		});
		await settle();

		const quality = page.wrapper.get('[data-cy="quality-toggle"]');
		expect(quality.text()).toContain("720p");
		await quality.trigger("click");
		await settle();
		const rendition = document.querySelector<HTMLElement>('[data-cy="quality-1"]');
		expect(rendition).not.toBeNull();
		rendition!.click();
		await settle();
		expect(useQualities().currentVideoTrack.value).toBe(1);

		await page.wrapper.get('[data-cy="subtitle-toggle"]').trigger("click");
		await settle();
		const track = document.querySelector<HTMLElement>('[data-cy="subtitle-0"]');
		expect(track).not.toBeNull();
		track!.click();
		await settle();
		expect(useCaptions().currentTrack.value).toBe(0);
		expect(useCaptions().isCaptionsEnabled.value).toBe(true);
	});

	it("opens the danmaku settings panel from the control bar", async () => {
		viewport.width = 1280;
		viewport.height = 720;
		page = mountComponent(VideoControls, {
			props: {
				sliderPosition: 100,
				truePosition: 100,
				controlsVisible: true,
				mode: "in-video",
			},
			global: { provide: { [PlayerFullscreenKey as symbol]: { toggle: vi.fn() } } },
		});
		await settle();

		await page.wrapper.get('[data-cy="danmaku-settings-toggle"]').trigger("click");
		await settle();
		const panel = document.querySelector<HTMLElement>(".danmaku-panel");
		expect(panel).not.toBeNull();
		expect(panel!.textContent).toContain("不透明度");
		// The block filters are chips now, not separate checkbox rows.
		expect(document.querySelector('[data-cy="danmaku-block-scroll"]')).not.toBeNull();
		expect(document.querySelector('[data-cy="danmaku-block-colored"]')).not.toBeNull();
	});

	it("keeps portrait controls compact, with volume and speed in settings, then expands on rotation or fullscreen", async () => {
		page = mountComponent(VideoControls, {
			props: {
				sliderPosition: 100,
				truePosition: 100,
				controlsVisible: true,
				mode: "in-video",
			},
			global: { provide: { [PlayerFullscreenKey as symbol]: { toggle: vi.fn() } } },
		});
		await settle();
		expect(page.wrapper.get(".video-controls").classes()).toContain("compact-controls");
		expect(page.wrapper.findComponent(BasicControls).findAll("button")).toHaveLength(1);
		expect(page.wrapper.find('[data-cy="playback-rate-toggle"]').exists()).toBe(false);
		expect(page.wrapper.find('[data-cy="volume-slider"]').exists()).toBe(false);
		await page.wrapper.get('[data-cy="player-settings-toggle"]').trigger("click");
		await settle();
		expect(
			document.querySelector('.compact-playback-options [data-cy="volume-slider"]'),
		).not.toBeNull();
		expect(
			document.querySelector('.compact-playback-options [data-cy="playback-rate-toggle"]'),
		).not.toBeNull();
		page.store.commit("SET_FULLSCREEN", true);
		await settle();
		expect(page.wrapper.get(".video-controls").classes()).not.toContain("compact-controls");
		expect(page.wrapper.findComponent(BasicControls).findAll("button")).toHaveLength(4);
		page.store.commit("SET_FULLSCREEN", false);
		viewport.width = 568;
		viewport.height = 320;
		for (const media of Array.from(mediaQueries)) {
			media.dispatchEvent(new Event("change"));
		}
		await settle();
		expect(page.wrapper.get(".video-controls").classes()).not.toContain("compact-controls");
		expect(page.wrapper.find('[data-cy="playback-rate-toggle"]').exists()).toBe(true);
		expect(page.wrapper.find('[data-cy="volume-slider"]').exists()).toBe(true);
	});

	it("updates layout controls after rotation and does not open hover tooltips on touch screens", async () => {
		const toggleFullscreen = vi.fn();
		page = mountComponent(
			defineComponent({
				components: { LayoutSwitcher, ClosedCaptionsSwitcher },
				template: "<div><LayoutSwitcher /><ClosedCaptionsSwitcher /></div>",
			}),
			{
				global: {
					stubs: { transition: false },
					provide: {
						[PlayerFullscreenKey as symbol]: { toggle: toggleFullscreen },
					},
				},
			},
		);
		await settle();
		expect(page.wrapper.findAll("button")).toHaveLength(2);
		await page.wrapper.get("button").trigger("mouseenter");
		await vi.advanceTimersByTimeAsync(1000);
		expect(document.querySelector(".v-tooltip.v-overlay--active")).toBeNull();
		await page.wrapper.get("button").trigger("click");
		expect(toggleFullscreen).toHaveBeenCalledOnce();

		viewport.width = 1024;
		for (const media of Array.from(mediaQueries)) {
			media.dispatchEvent(new Event("change"));
		}
		await settle();
		expect(page.wrapper.findAll("button")).toHaveLength(3);

		viewport.width = 390;
		for (const media of Array.from(mediaQueries)) {
			media.dispatchEvent(new Event("change"));
		}
		await settle();
		expect(page.wrapper.findAll("button")).toHaveLength(2);
	});
});
