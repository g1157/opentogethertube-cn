import { describe, expect, it, vi } from "vitest";
import PlayerStatsPanel from "@/components/PlayerStatsPanel.vue";
import { mountComponent } from "./component-test-utils";

function fakeVideo(): HTMLVideoElement {
	const video = document.createElement("video");
	Object.defineProperties(video, {
		videoWidth: { value: 1280, configurable: true },
		videoHeight: { value: 720, configurable: true },
		duration: { value: 600, configurable: true },
		currentTime: { value: 10, configurable: true },
		paused: { value: false, configurable: true },
		readyState: { value: 4, configurable: true },
		playbackRate: { value: 1, configurable: true },
		buffered: { value: { length: 1, start: () => 0, end: () => 30 }, configurable: true },
	});
	video.getBoundingClientRect = () =>
		({
			width: 1280,
			height: 720,
			top: 0,
			left: 0,
			right: 1280,
			bottom: 720,
			x: 0,
			y: 0,
		}) as DOMRect;
	return video;
}

describe("playback details panel", () => {
	it("renders the live video data while it is open", async () => {
		const { wrapper } = mountComponent(PlayerStatsPanel, {
			props: { videoElement: fakeVideo() },
		});
		await Promise.resolve();

		const text = wrapper.text();
		expect(text).toContain("视频详情");
		expect(text).toContain("分辨率");
		expect(text).toContain("1280×720");
		expect(text).toContain("播放中");
	});

	it("says so when the current player has no video element", async () => {
		const { wrapper } = mountComponent(PlayerStatsPanel, { props: {} });
		await Promise.resolve();

		expect(wrapper.text()).toContain("嵌入播放器");
	});

	it("closes from its own button", async () => {
		// The overlay itself is pointer-events: none (see the component styles) so the
		// picture and the playback gestures underneath stay reachable; only this button
		// takes clicks, and it opens no modal, so playback never pauses.
		const onClose = vi.fn();
		const { wrapper } = mountComponent(PlayerStatsPanel, {
			props: { videoElement: fakeVideo() },
			attrs: { onClose },
		});
		await Promise.resolve();

		expect(wrapper.find(".player-stats-close").exists()).toBe(true);
		await wrapper.find(".player-stats-close").trigger("click");
		expect(onClose).toHaveBeenCalled();
	});
});
