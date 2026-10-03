import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import DanmakuLayer from "@/components/players/DanmakuLayer.vue";
import { flush, mountComponent } from "./component-test-utils";

vi.mock("@/util/danmaku/provider", () => ({
	findDanmakuProvider: () => ({
		url: "https://danmu.example/ep01.xml",
		provider: {
			load: async () => [{ time: 0, mode: "scroll", color: "#ffffff", text: "hi" }],
		},
	}),
}));

function makeVideo() {
	const video = document.createElement("video");
	Object.defineProperties(video, {
		videoWidth: { configurable: true, get: () => 640 },
		videoHeight: { configurable: true, get: () => 360 },
		currentTime: { configurable: true, get: () => 0 },
		paused: { configurable: true, get: () => false },
		requestVideoFrameCallback: {
			configurable: true,
			value: vi.fn(() => 1),
		},
		cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
		getBoundingClientRect: {
			configurable: true,
			value: () =>
				({
					width: 640,
					height: 360,
					x: 0,
					y: 0,
					top: 0,
					left: 0,
					right: 640,
					bottom: 360,
					toJSON: () => ({}),
				}) as DOMRect,
		},
	});
	return video;
}

describe("danmaku layer frame scheduling", () => {
	beforeEach(() => {
		// jsdom has no 2d context; returning null keeps the layer on its no-draw path
		// instead of logging a "not implemented" error on every frame.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			(() => null) as typeof HTMLCanvasElement.prototype.getContext,
		);
	});

	it("releases the old element's frame callback and keeps drawing on the replacement", async () => {
		const first = makeVideo();
		const second = makeVideo();
		const { wrapper } = mountComponent(DanmakuLayer, {
			props: { video: first, videoUrl: "/media/ep01.mp4" },
		});
		await flush();
		await nextTick();

		// The layer sizes itself from the video's box the way a ResizeObserver delivery
		// does in a browser; jsdom's stub never delivers that first observation.
		window.dispatchEvent(new Event("resize"));
		await nextTick();

		expect(first.requestVideoFrameCallback).toHaveBeenCalled();
		const scheduledId = (
			first.requestVideoFrameCallback as unknown as ReturnType<typeof vi.fn>
		).mock.results.at(-1)!.value as number;

		await wrapper.setProps({ video: second });
		await flush();
		await nextTick();

		// The pending handle belongs to the first element and has to be released there; a
		// stale non-zero handle would make every later schedule() call bail out.
		expect(first.cancelVideoFrameCallback).toHaveBeenCalledWith(scheduledId);
		expect(second.requestVideoFrameCallback).toHaveBeenCalled();
	});
});
