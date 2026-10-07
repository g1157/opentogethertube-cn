import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { flush, mountComponent } from "./component-test-utils";
import { useDanmaku } from "@/components/composables";
import toast from "@/util/toast";

const {
	loadGirigiriTrack,
	autoMatch,
	danmuApiLoad,
	roomSourceBinding,
	girigiriLoad,
	bindingState,
} = vi.hoisted(() => ({
	loadGirigiriTrack: vi.fn(),
	autoMatch: vi.fn(),
	danmuApiLoad: vi.fn(),
	roomSourceBinding: vi.fn(),
	girigiriLoad: vi.fn(),
	bindingState: { binding: null as Record<string, unknown> | null },
}));
/** The URL rules know nothing about this video; only the stored binding does. */
vi.mock("@/util/danmaku/provider", () => ({
	findDanmakuProvider: () => null,
}));
vi.mock("@/util/danmaku/girigiri", () => ({
	girigiriProvider: { load: girigiriLoad },
}));
vi.mock("@/util/danmaku/girigiri-api", () => ({ loadGirigiriTrack }));
vi.mock("@/util/danmaku/danmu-api", () => ({
	autoMatch,
	bindingsState: { value: {} },
	danmuApiProvider: { load: danmuApiLoad },
	getBinding: () => bindingState.binding,
	getDanmakuApiBase: () => "",
	looksLikeRemoteCandidate: () => true,
	rememberBinding: vi.fn(),
	roomSourceBinding,
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
		roomSourceBinding.mockReturnValue(null);
		bindingState.binding = {
			provider: "girigiri",
			page: "/playGV1-1-1/",
			label: "异国日记",
			offset: 2,
		};
		loadGirigiriTrack.mockResolvedValue([
			{ time: 5, mode: "scroll", color: "#ffffff", text: "bound" },
		]);
		girigiriLoad.mockResolvedValue([
			{ time: 5, mode: "scroll", color: "#ffffff", text: "url-bound" },
		]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("plays the bound girigiri track through the bridge and stands the matcher down", async () => {
		const video = makeVideo();
		const { wrapper, store } = mountComponent(DanmakuLayer, {
			props: { video, videoUrl: "https://example.com/other-site/01.mp4" },
		});
		// Danmaku starts off by default now; enabling it is what loads a bound track.
		store.commit("settings/UPDATE_TRANSIENT", { danmakuEnabled: true });
		await flush();
		await nextTick();

		expect(loadGirigiriTrack).toHaveBeenCalledWith("/playGV1-1-1/");
		// The user picked this episode; nothing else may override it.
		expect(autoMatch).not.toHaveBeenCalled();
		expect(danmuApiLoad).not.toHaveBeenCalled();
		// A binding alone makes the source available, even with no API base configured,
		// and the panel can show how many comments arrived.
		expect(useDanmaku().available.value).toBe(true);
		expect(useDanmaku().loadedCount.value).toBe(1);
		wrapper.unmount();
	});

	it("follows the room's shared source ahead of this device's own binding", async () => {
		roomSourceBinding.mockReturnValue({
			provider: "girigiri",
			page: "/playGV2-2-2/",
			label: "房间的源",
			offset: 0,
		});
		const video = makeVideo();
		const { wrapper, store } = mountComponent(DanmakuLayer, {
			props: { video, videoUrl: "https://example.com/other-site/01.mp4" },
		});
		store.commit("settings/UPDATE_TRANSIENT", { danmakuEnabled: true });
		await flush();
		await nextTick();

		expect(loadGirigiriTrack).toHaveBeenCalledWith("/playGV2-2-2/");
		expect(autoMatch).not.toHaveBeenCalled();
		expect(danmuApiLoad).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it("loads a URL-matched girigiri track the visitor edited", async () => {
		// A track matched by the URL rules usually has no binding; editing its offset
		// stores one, located by the track URL, and the layer must load it from there.
		bindingState.binding = {
			provider: "girigiri",
			url: "https://danmu.example/other/01.xml",
			label: "girigiri · /other/01.xml",
			offset: 1,
		};
		const video = makeVideo();
		const { wrapper, store } = mountComponent(DanmakuLayer, {
			props: { video, videoUrl: "https://example.com/other-site/01.mp4" },
		});
		store.commit("settings/UPDATE_TRANSIENT", { danmakuEnabled: true });
		await flush();
		await nextTick();

		expect(girigiriLoad).toHaveBeenCalledWith("https://danmu.example/other/01.xml");
		expect(loadGirigiriTrack).not.toHaveBeenCalled();
		expect(useDanmaku().loadedCount.value).toBe(1);
		wrapper.unmount();
	});

	it("shifts a running track when only the room offset changed, silently", async () => {
		const source = (offset: number) => ({
			videoUrl: "https://example.com/other-site/01.mp4",
			provider: "girigiri" as const,
			page: "/playGV2-2-2/",
			label: "房间的源",
			offset,
		});
		bindingState.binding = null;
		const video = makeVideo();
		const { wrapper, store } = mountComponent(DanmakuLayer, {
			props: { video, videoUrl: "https://example.com/other-site/01.mp4" },
		});
		store.commit("settings/UPDATE_TRANSIENT", { danmakuEnabled: true });
		await flush();
		await nextTick();
		// The room shares this track (offset 0): the first load fetches it.
		roomSourceBinding.mockReturnValue(source(0));
		store.commit("room/SYNC", { danmakuSource: source(0) });
		await flush();
		await nextTick();
		expect(loadGirigiriTrack).toHaveBeenCalledTimes(1);
		expect(useDanmaku().loadedCount.value).toBe(1);
		const toastSpy = vi.spyOn(toast, "add");
		loadGirigiriTrack.mockClear();

		// Dragging the offset publishes the same track with a new offset; the sync lands
		// as a fresh source object.
		roomSourceBinding.mockReturnValue(source(5));
		store.commit("room/SYNC", { danmakuSource: source(5) });
		await flush();
		await nextTick();

		// Same track: no refetch, no blank, no repeated announcement.
		expect(loadGirigiriTrack).not.toHaveBeenCalled();
		expect(useDanmaku().loadedCount.value).toBe(1);
		expect(toastSpy).not.toHaveBeenCalled();
		toastSpy.mockRestore();
		wrapper.unmount();
	});
});
