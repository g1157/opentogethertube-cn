import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mountComponent } from "./component-test-utils";
import { useDanmaku } from "@/components/composables";

/** The URL rules know nothing about this video; only the stored binding does. */
vi.mock("@/util/danmaku/provider", () => ({ findDanmakuProvider: () => null }));

const { loadGirigiriTrack, autoMatch, danmuApiLoad } = vi.hoisted(() => ({
	loadGirigiriTrack: vi.fn(),
	autoMatch: vi.fn(),
	danmuApiLoad: vi.fn(),
}));
vi.mock("@/util/danmaku/girigiri-api", () => ({ loadGirigiriTrack }));
vi.mock("@/util/danmaku/danmu-api", () => ({
	autoMatch,
	bindingsState: { value: {} },
	danmuApiProvider: { load: danmuApiLoad },
	getBinding: () => ({
		provider: "girigiri",
		page: "/playGV1-1-1/",
		label: "异国日记",
		offset: 2,
	}),
	getDanmakuApiBase: () => "",
	looksLikeRemoteCandidate: () => true,
	rememberBinding: vi.fn(),
	setDanmakuApiBase: vi.fn(),
	trackUrl: () => null,
}));

import DanmakuLayer from "@/components/players/DanmakuLayer.vue";

function makeVideo() {
	const video = document.createElement("video");
	const state = { paused: true, currentTime: 0 };
	Object.defineProperties(video, {
		paused: { configurable: true, get: () => state.paused },
		currentTime: { configurable: true, get: () => state.currentTime },
		videoWidth: { configurable: true, get: () => 640 },
		videoHeight: { configurable: true, get: () => 360 },
		getBoundingClientRect: {
			configurable: true,
			value: () => ({ width: 640, height: 360, top: 0, left: 0 }),
		},
	});
	return video;
}

describe("danmaku layer bindings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		loadGirigiriTrack.mockResolvedValue([
			{ time: 5, mode: "scroll", color: "#ffffff", text: "bound" },
		]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("plays the bound girigiri track through the bridge and stands the matcher down", async () => {
		const video = makeVideo();
		const { wrapper } = mountComponent(DanmakuLayer, {
			props: { video, videoUrl: "https://example.com/other-site/01.mp4" },
		});
		await flush();

		expect(loadGirigiriTrack).toHaveBeenCalledWith("/playGV1-1-1/");
		// The user picked this episode; nothing else may override it.
		expect(autoMatch).not.toHaveBeenCalled();
		expect(danmuApiLoad).not.toHaveBeenCalled();
		// A binding alone makes the source available, even with no API base configured.
		expect(useDanmaku().available.value).toBe(true);
		wrapper.unmount();
	});
});
