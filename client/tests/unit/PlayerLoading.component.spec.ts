import { flushPromises } from "@vue/test-utils";
import { defineComponent, h, onMounted } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerStatus } from "ott-common/models/types";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import type { MediaPlayer } from "@/components/composables/media-player";
import { mountComponent } from "./component-test-utils";

describe("player loading feedback", () => {
	let page: ReturnType<typeof mountComponent> | undefined;
	let api: MediaPlayer;
	let nativePlayer: ReturnType<typeof defineComponent>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		api = {
			play: vi.fn(),
			pause: vi.fn(),
			getPosition: vi.fn(() => 310),
			setPosition: vi.fn(),
			setVolume: vi.fn(),
			retry: vi.fn(),
			isCaptionsSupported: () => false,
			isQualitySupported: () => false,
			getAvailablePlaybackRates: () => [1],
		};
		nativePlayer = defineComponent({
			name: "DirectPlayer",
			emits: [
				"apiready",
				"ready",
				"playing",
				"paused",
				"buffering",
				"error",
				"loading-state",
			],
			setup(_, { emit, expose }) {
				expose(api);
				onMounted(() => emit("apiready"));
				return () => h("div", { "data-cy": "native-player-double" });
			},
		});
	});

	afterEach(() => {
		page?.wrapper.unmount();
		page = undefined;
		vi.useRealTimers();
	});

	async function mountPlayer() {
		page = mountComponent(OmniPlayer, {
			props: {
				source: {
					service: "direct",
					id: "https://media.example/current-episode.mp4",
					mime: "video/mp4",
					length: 1800,
				},
			},
			global: { stubs: { DirectPlayer: nativePlayer } },
		});
		await flushPromises();
		page.store.state.room.isPlaying = true;
		page.store.state.room.playbackPosition = 310;
		const native = page.wrapper.getComponent(nativePlayer);
		return { ...page, native };
	}

	it("keeps a joiner's loading notice after ready and playing until a video frame is available", async () => {
		const { wrapper, native, store } = await mountPlayer();
		native.vm.$emit("ready");
		native.vm.$emit("playing");
		native.vm.$emit("loading-state", {
			phase: "waiting-frame",
			currentTime: 310,
			bufferAhead: 2,
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.state.playerStatus).toBe(PlayerStatus.ready);
		expect(wrapper.get('[data-cy="media-loading-notice"]').text()).toContain("正在等待画面");
		expect(store.state.room.isPlaying).toBe(true);
		native.vm.$emit("loading-state", { phase: null, currentTime: 310, bufferAhead: 2 });
		await flushPromises();
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(false);
	});

	it("gives autoplay blocking and a final error priority over a waiting animation", async () => {
		const { wrapper, native } = await mountPlayer();
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(true);
		await wrapper.setProps({ playbackBlocked: true });
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(false);
		await wrapper.setProps({ playbackBlocked: false });
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(true);
		native.vm.$emit("error", { type: "network" });
		await flushPromises();
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(false);
		expect(wrapper.find(".playback-error").exists()).toBe(true);
	});

	it("offers retry after a long wait without sending any room command or changing room playback", async () => {
		const { wrapper, store, connection } = await mountPlayer();
		const send = vi.spyOn(connection, "send");
		await vi.advanceTimersByTimeAsync(15000);
		await wrapper.get('[data-cy="retry-loading-media"]').trigger("click");
		expect(api.retry).toHaveBeenCalledOnce();
		expect(wrapper.emitted("retry")).toHaveLength(1);
		expect(send).not.toHaveBeenCalled();
		expect(store.state.room.isPlaying).toBe(true);
		expect(store.state.room.playbackPosition).toBe(310);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.text()).toContain("已等待 1 秒");
		expect(wrapper.find('[data-cy="retry-loading-media"]').exists()).toBe(false);
	});

	it("starts a new wait and clears stale buffer information when the video source changes", async () => {
		const { wrapper, native } = await mountPlayer();
		native.vm.$emit("loading-state", { phase: "buffering", currentTime: 310, bufferAhead: 8 });
		await vi.advanceTimersByTimeAsync(14000);
		await wrapper.setProps({
			source: {
				service: "direct",
				id: "https://media.example/another-episode.mp4",
				mime: "video/mp4",
				length: 1800,
			},
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.text()).toContain("正在准备视频");
		expect(wrapper.text()).toContain("已等待 1 秒");
		expect(wrapper.text()).not.toContain("已缓存 8");
		expect(wrapper.find('[data-cy="retry-loading-media"]').exists()).toBe(false);
	});

	it("keeps preparation feedback after a local frame until the first viewer is ready", async () => {
		const { wrapper, native, store } = await mountPlayer();
		store.state.room.isPlaying = false;
		await wrapper.setProps({ waitingForPreparedPlayback: true });
		const frame = { phase: null, currentTime: 310, bufferAhead: 4 };
		native.vm.$emit("loading-state", frame);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.text()).toContain("等待首位观众准备好");
		expect(wrapper.emitted("loading-state")?.at(-1)).toEqual([frame]);
		await wrapper.setProps({ waitingForPreparedPlayback: false });
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(false);
	});
});
