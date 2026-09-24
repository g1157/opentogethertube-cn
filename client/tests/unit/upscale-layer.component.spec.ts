import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UpscaleLayer from "@/components/players/UpscaleLayer.vue";
import { flush, mountComponent } from "./component-test-utils";

const drivers = vi.hoisted(() => ({
	sharpen: vi.fn(),
	film: vi.fn(),
	anime4k: vi.fn(),
}));

vi.mock("@/util/upscale/cas", () => ({ startSharpenRenderer: drivers.sharpen }));
vi.mock("@/util/upscale/film", () => ({ startFilmRenderer: drivers.film }));
vi.mock("@/util/upscale/anime4k", () => ({ startAnime4KRenderer: drivers.anime4k }));

let clock = 0;

function renderer() {
	return { stop: vi.fn() };
}

/**
 * A video element with the pieces the layer touches, plus a hand-cranked
 * requestVideoFrameCallback so a test controls exactly when frames are presented —
 * which is the only way to reproduce a pause, since browsers stop calling back then.
 */
function fakeVideo() {
	const callbacks = new Map<number, () => void>();
	let nextId = 1;
	const video = document.createElement("video");
	Object.defineProperties(video, {
		videoWidth: { value: 1920, configurable: true },
		videoHeight: { value: 1080, configurable: true },
		paused: { value: false, configurable: true },
		readyState: { value: 4, configurable: true },
		textTracks: { value: [], configurable: true },
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
			toJSON: () => ({}),
		}) as DOMRect;
	video.requestVideoFrameCallback = ((callback: () => void) => {
		const id = nextId++;
		callbacks.set(id, callback);
		return id;
	}) as HTMLVideoElement["requestVideoFrameCallback"];
	video.cancelVideoFrameCallback = ((id: number) => {
		callbacks.delete(id);
	}) as HTMLVideoElement["cancelVideoFrameCallback"];
	return {
		video,
		/** Present one frame after the given elapsed time. */
		fire(deltaMs: number) {
			clock += deltaMs;
			const next = [...callbacks.entries()][0];
			if (!next) {
				throw new Error("no frame callback is registered");
			}
			callbacks.delete(next[0]);
			next[1]();
		},
	};
}

async function settle() {
	await flush();
	await new Promise(resolve => setTimeout(resolve, 0));
	await flush();
}

describe("enhancement layer lifecycle", () => {
	beforeEach(() => {
		clock = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		// The layer only feature-detects WebGPU before handing off to the driver, and the
		// driver is mocked here, so the marker is all jsdom needs.
		Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
		drivers.sharpen.mockImplementation(() => renderer());
		drivers.film.mockImplementation(() => renderer());
		drivers.anime4k.mockImplementation(() => Promise.resolve(renderer()));
	});
	afterEach(() => {
		Reflect.deleteProperty(navigator, "gpu");
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("gives every renderer a canvas of its own", async () => {
		// A canvas keeps the context type it was first asked for and the sharpen pass
		// loses its WebGL context on stop, so a reused canvas cannot host a second
		// renderer: switching tiers or reloading the media would fail to get a context.
		const first = fakeVideo();
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video: first.video, mode: "sharpen" },
		});
		await settle();
		const originalCanvas = wrapper.find("canvas").element;
		expect(originalCanvas).toBeDefined();

		await wrapper.setProps({ video: fakeVideo().video });
		await settle();

		const replacement = wrapper.find("canvas").element;
		expect(replacement).not.toBe(originalCanvas);
		expect(document.body.contains(replacement)).toBe(true);
		expect(document.body.contains(originalCanvas)).toBe(false);
	});

	it("discards a slow start instead of letting it displace the live renderer", async () => {
		let finishStale: (value: unknown) => void = () => undefined;
		drivers.anime4k.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					finishStale = resolve;
				}),
		);
		const live = renderer();
		drivers.anime4k.mockImplementationOnce(() => Promise.resolve(live));

		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video: fakeVideo().video, mode: "anime4k" },
		});
		await settle();

		// A second start takes over — the user switched the media — and finishes first.
		await wrapper.setProps({ video: fakeVideo().video });
		await settle();

		// Only now does the abandoned start return. Installing it would replace the live
		// renderer with a dead one, and nothing would hold a reference to stop the live one.
		const stale = renderer();
		finishStale(stale);
		await settle();
		expect(stale.stop).toHaveBeenCalled();

		wrapper.unmount();
		expect(live.stop).toHaveBeenCalled();
	});

	it("does not count a pause as a slow window", async () => {
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		// Three seconds of healthy 30fps playback.
		for (let i = 0; i < 90; i++) {
			fire(33);
		}
		// The viewer pauses to compare quality. requestVideoFrameCallback goes silent, so
		// no code of ours runs for the whole pause — only the next frame can notice it.
		clock += 30_000;
		// Playback resumes; the guard must wait out a full window before judging.
		for (let i = 0; i < 200; i++) {
			fire(33);
		}

		expect(store.state.settings.upscaleScale).toBe("auto");
	});

	it("runs the heavy preset for the quality tier and the fast one otherwise", async () => {
		const quality = fakeVideo();
		mountComponent(UpscaleLayer, { props: { video: quality.video, mode: "anime4k-quality" } });
		await settle();
		expect(drivers.anime4k).toHaveBeenCalledTimes(1);
		expect(drivers.anime4k.mock.calls[0][2]).toBe("quality");

		const fast = fakeVideo();
		mountComponent(UpscaleLayer, { props: { video: fast.video, mode: "anime4k" } });
		await settle();
		expect(drivers.anime4k.mock.calls[1][2]).toBe("fast");
	});

	it("drops the quality tier to the fast preset before touching the scale", async () => {
		// The heavy chain is the first thing to give up: same upscale, about half the cost.
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k-quality" },
		});
		await settle();

		for (let i = 0; i < 80; i++) {
			fire(100);
		}

		expect(store.state.settings.upscaleMode).toBe("anime4k");
	});

	it("steps down when the driver gives up after starting", async () => {
		// WebGPU can fail asynchronously (a lost device, a validation error caught by the
		// error scope). Without this the tier would leave a dead canvas on screen.
		let fatal: ((message: string) => void) | undefined;
		drivers.anime4k.mockImplementationOnce(
			(
				_video: unknown,
				_canvas: unknown,
				_variant: unknown,
				onFatal: (m: string) => void,
			) => {
				fatal = onFatal;
				return Promise.resolve(renderer());
			},
		);
		const { video } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, { props: { video, mode: "anime4k" } });
		await settle();

		expect(fatal).toBeTypeOf("function");
		fatal?.("WebGPU device lost (destroyed)");
		await settle();

		// A failed AI tier still lands on the tier that works everywhere.
		expect(store.state.settings.upscaleMode).toBe("sharpen");
	});

	it("steps the film chain down to plain sharpening when the device cannot keep up", async () => {
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, { props: { video, mode: "film" } });
		await settle();

		for (let i = 0; i < 80; i++) {
			fire(100);
		}

		expect(store.state.settings.upscaleMode).toBe("sharpen");
	});

	it("runs the film chain for the live-action tier", async () => {
		const { video } = fakeVideo();
		mountComponent(UpscaleLayer, { props: { video, mode: "film" } });
		await settle();

		expect(drivers.film).toHaveBeenCalledTimes(1);
		expect(drivers.sharpen).not.toHaveBeenCalled();
	});

	it("still steps down when playback is genuinely slow", async () => {
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		// 10fps for longer than one window: real, sustained slowness with no stall in it.
		for (let i = 0; i < 80; i++) {
			fire(100);
		}

		// The canvas is sized to the source resolution (auto no longer undersamples),
		// so the next rung under 1x is 0.75.
		expect(store.state.settings.upscaleScale).toBe(0.75);
	});

	it("leaves the tier alone when the viewer turned auto-degrade off", async () => {
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		store.commit("settings/UPDATE", { upscaleAutoDegrade: false });
		await settle();

		for (let i = 0; i < 80; i++) {
			fire(100);
		}

		expect(store.state.settings.upscaleScale).toBe("auto");
	});

	function resizeVideo(video: HTMLVideoElement, width: number, height: number) {
		video.getBoundingClientRect = () =>
			({
				width,
				height,
				top: 0,
				left: 0,
				right: width,
				bottom: height,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;
	}

	it("rebuilds the AI tier at the displayed size when the viewport changes", async () => {
		const { video } = fakeVideo();
		mountComponent(UpscaleLayer, { props: { video, mode: "anime4k" } });
		await settle();
		expect(drivers.anime4k).toHaveBeenCalledTimes(1);
		const firstCanvas = drivers.anime4k.mock.calls[0][1] as HTMLCanvasElement;

		// Entering fullscreen (or a wider window) draws the same source much larger, and the
		// Anime4K pipeline captures its target size when it is built: without a rebuild the
		// canvas keeps the windowed resolution and the browser stretches it.
		resizeVideo(video, 2560, 1440);
		window.dispatchEvent(new Event("resize"));
		await settle();
		// A rebuild costs a device and a pipeline, so it waits for the viewport to settle.
		expect(drivers.anime4k).toHaveBeenCalledTimes(1);

		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();
		expect(drivers.anime4k).toHaveBeenCalledTimes(2);
		const secondCanvas = drivers.anime4k.mock.calls[1][1] as HTMLCanvasElement;
		expect(secondCanvas.width).toBeGreaterThan(firstCanvas.width);
		expect(secondCanvas.height).toBeGreaterThan(firstCanvas.height);
	});

	it("resizes the sharpen canvas in place instead of restarting the pass", async () => {
		const { video } = fakeVideo();
		const { wrapper } = mountComponent(UpscaleLayer, { props: { video, mode: "sharpen" } });
		await settle();
		const canvas = wrapper.find("canvas").element as HTMLCanvasElement;
		const before = [canvas.width, canvas.height];

		resizeVideo(video, 2560, 1440);
		window.dispatchEvent(new Event("resize"));
		await settle();
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		// The shader reads the canvas size every frame, so the same pass just gets more pixels.
		expect(drivers.sharpen).toHaveBeenCalledTimes(1);
		expect(canvas.width).toBeGreaterThan(before[0]);
	});
});
