import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UpscaleLayer from "@/components/players/UpscaleLayer.vue";
import { flush, mountComponent } from "./component-test-utils";

const drivers = vi.hoisted(() => ({
	sharpen: vi.fn(),
	film: vi.fn(),
	anime4k: vi.fn(),
	anime4kWebGL: vi.fn(),
	anime4kUltra: vi.fn(),
	probe: vi.fn(),
}));
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

vi.mock("@/util/upscale/cas", () => ({ startSharpenRenderer: drivers.sharpen }));
vi.mock("@/util/upscale/film", () => ({ startFilmRenderer: drivers.film }));
vi.mock("@/util/upscale/anime4k", () => ({ startAnime4KRenderer: drivers.anime4k }));
vi.mock("@/util/upscale/anime4k-webgl", () => ({
	startAnime4KWebGLRenderer: drivers.anime4kWebGL,
}));
vi.mock("@/util/upscale/anime4k-ultra", () => ({
	startAnime4KUltraRenderer: drivers.anime4kUltra,
}));
vi.mock("@/util/upscale/webgpu-probe", () => ({
	canRunWebGPUEnhancement: drivers.probe,
}));

let clock = 0;

function renderer() {
	return { stop: vi.fn(), redraw: vi.fn() };
}

/**
 * A video element with the pieces the layer touches, plus a hand-cranked
 * requestVideoFrameCallback so a test controls exactly when frames are presented —
 * which is the only way to reproduce a pause, since browsers stop calling back then.
 */
function fakeVideo() {
	const callbacks = new Map<
		number,
		(now: number, metadata: VideoFrameCallbackMetadata) => void
	>();
	let nextId = 1;
	/** Added to the media clock, so a test can simulate a seek. */
	let mediaOffset = 0;
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
	video.requestVideoFrameCallback = ((
		callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
	) => {
		const id = nextId++;
		callbacks.set(id, callback);
		return id;
	}) as HTMLVideoElement["requestVideoFrameCallback"];
	video.cancelVideoFrameCallback = ((id: number) => {
		callbacks.delete(id);
	}) as HTMLVideoElement["cancelVideoFrameCallback"];
	return {
		video,
		/**
		 * Present one frame after the given elapsed time. `mediaAdvanceMs` says how far the media
		 * clock moved in that time: equal to the wall clock while playback runs at 1x, 0 while the
		 * pipeline has nothing to present (a rebuffer), and larger across a seek.
		 */
		fire(deltaMs: number, mediaAdvanceMs = deltaMs) {
			clock += deltaMs;
			const next = [...callbacks.entries()][0];
			if (!next) {
				throw new Error("no frame callback is registered");
			}
			callbacks.delete(next[0]);
			// Playback runs at 1x, so the media clock follows the wall clock and a frame
			// presented late leaves a gap in the media times the pacing check can see.
			next[1](clock, {
				mediaTime: clock / 1000 + mediaOffset - (deltaMs - mediaAdvanceMs) / 1000,
			} as VideoFrameCallbackMetadata);
		},
		/** Jump the media clock like a seek does, announced the way the element announces it. */
		seekBy(seconds: number) {
			mediaOffset += seconds;
			video.dispatchEvent(new Event("seeking"));
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
		drivers.anime4kWebGL.mockImplementation(() => renderer());
		drivers.anime4kUltra.mockImplementation(() => renderer());
		// The probe answers before the WebGPU chunk is imported; the driver is mocked here, so a
		// usable adapter is all these tests need to exercise the WebGPU branch.
		drivers.probe.mockImplementation(() => Promise.resolve(true));
	});
	afterEach(() => {
		Reflect.deleteProperty(navigator, "gpu");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("redraws a paused WebGL picture after changing its render scale", async () => {
		const live = renderer();
		drivers.sharpen.mockReturnValueOnce(live);
		const { video } = fakeVideo();
		Object.defineProperty(video, "paused", { value: true });
		const { wrapper, store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();
		store.commit("settings/UPDATE", { upscaleScale: 2 });
		await settle();

		expect(wrapper.find("canvas").element.width).toBe(3840);
		expect(live.redraw).toHaveBeenCalledTimes(1);
	});

	it("redraws a paused sharpen picture after a viewport resize settles", async () => {
		const live = renderer();
		drivers.sharpen.mockReturnValueOnce(live);
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video: fakeVideo().video, mode: "sharpen" },
		});
		await settle();
		window.dispatchEvent(new Event("resize"));
		// The target moves once the viewport settles: a WebGL2 re-size re-plans the chain and
		// hands the old render targets back, so a drag must not do it per resize event.
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(live.redraw).toHaveBeenCalledTimes(1);
		expect(drivers.sharpen).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it("redraws once for a burst of viewport resizes", async () => {
		// Dragging a window edge fires resize on every frame. Each one would re-plan the HQ
		// chain and re-allocate up to ~390 MiB of half-float targets.
		const live = renderer();
		drivers.anime4kWebGL.mockReturnValueOnce(live);
		drivers.probe.mockImplementationOnce(() => Promise.resolve(false));
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video: fakeVideo().video, mode: "anime4k" },
		});
		await settle();
		for (let i = 0; i < 20; i++) {
			window.dispatchEvent(new Event("resize"));
		}
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(live.redraw).toHaveBeenCalledTimes(1);
		expect(drivers.anime4kWebGL).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it("resizes and redraws a paused WebGL CNN target when the fit changes to cover", async () => {
		const live = renderer();
		drivers.anime4kUltra.mockReturnValueOnce(live);
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		resizeVideo(video, 1000, 1000);
		const { wrapper, store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k-ultra" },
		});
		await settle();
		const canvas = wrapper.find("canvas").element;
		expect(canvas.height).toBeLessThan(1000);
		store.commit("settings/UPDATE", { videoFillMode: "cover" });
		await settle();

		expect([canvas.width, canvas.height]).toEqual([1778, 1000]);
		expect(live.redraw).toHaveBeenCalledTimes(1);
		expect(drivers.anime4kUltra).toHaveBeenCalledTimes(1);
	});

	it("rebuilds a WebGPU CNN at the cover target instead of stretching its old picture", async () => {
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		resizeVideo(video, 1000, 1000);
		const { wrapper, store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k" },
		});
		await settle();
		expect(drivers.anime4k).toHaveBeenCalledTimes(1);
		store.commit("settings/UPDATE", { videoFillMode: "cover" });
		await settle();

		expect(drivers.anime4k).toHaveBeenCalledTimes(2);
		const canvas = wrapper.find("canvas").element;
		expect([canvas.width, canvas.height]).toEqual([1778, 1000]);
	});

	it("drops a failed WebGL renderer instead of leaving its frozen canvas enabled", async () => {
		let fatal: ((message: string) => void) | undefined;
		const live = renderer();
		drivers.sharpen.mockImplementationOnce((_video, _canvas, _amount, onFatal) => {
			fatal = onFatal;
			return live;
		});
		const { wrapper, store } = mountComponent(UpscaleLayer, {
			props: { video: fakeVideo().video, mode: "sharpen" },
		});
		store.commit("settings/UPDATE", { upscaleMode: "sharpen" });
		await settle();

		expect(fatal).toBeTypeOf("function");
		fatal?.("WebGL context lost");
		await settle();
		expect(store.state.settings.upscaleMode).toBe("off");
		expect(live.stop).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it("keeps one canvas per context kind so a rebuild can reuse its programs", async () => {
		// A canvas keeps the context type it was first asked for, so WebGL2 and WebGPU need a
		// canvas each — but rebuilding on the same one preserves its context and the programs
		// linked on it, which is what stops every tier switch from re-linking the chain.
		const first = fakeVideo();
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video: first.video, mode: "sharpen" },
		});
		await settle();
		const sharpCanvas = wrapper.find("canvas").element;
		expect(sharpCanvas).toBeDefined();

		// Another WebGL2 tier rebuilds onto the same canvas rather than a fresh one.
		await wrapper.setProps({ mode: "film" });
		await settle();
		expect(wrapper.find("canvas").element).toBe(sharpCanvas);

		// The AI tiers take the WebGPU canvas, which must not be the WebGL2 one.
		await wrapper.setProps({ mode: "anime4k" });
		await settle();
		const webgpuCanvas = drivers.anime4k.mock.calls[0][1] as HTMLCanvasElement;
		expect(webgpuCanvas).not.toBe(sharpCanvas);
		expect(wrapper.find("canvas").element).toBe(webgpuCanvas);
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

	it("runs the Anime4K network on WebGL2 when WebGPU cannot start", async () => {
		// Firefox outside Windows and Nightly exposes navigator.gpu but hands out no adapter,
		// and a blocklisted driver fails the same way: the same network has a WebGL2 chain.
		drivers.anime4k.mockImplementationOnce(() =>
			Promise.reject(new Error("WebGPU adapter unavailable")),
		);
		const { store } = mountComponent(UpscaleLayer, {
			props: { video: fakeVideo().video, mode: "anime4k" },
		});
		store.commit("settings/UPDATE", { upscaleMode: "anime4k" });
		await settle();

		expect(drivers.anime4kWebGL).toHaveBeenCalledTimes(1);
		// The tier ran, so it must not step down to sharpening or off.
		expect(store.state.settings.upscaleMode).toBe("anime4k");
		// A canvas keeps the context type it was first asked for, so the WebGL2 chain gets one
		// of its own rather than the canvas the failed start may have claimed.
		expect(drivers.anime4kWebGL.mock.calls[0][1]).not.toBe(drivers.anime4k.mock.calls[0][1]);
		// It also has to be sized like the canvas it replaced: a fresh canvas holds the 300x150
		// default, and the WebGL2 chain takes its render size straight from the canvas, so an
		// unsized one drew a 2:1 picture the browser letterboxed over the 16:9 video.
		const webglCanvas = drivers.anime4kWebGL.mock.calls[0][1] as HTMLCanvasElement;
		const firstCanvas = drivers.anime4k.mock.calls[0][1] as HTMLCanvasElement;
		expect(webglCanvas.width).toBe(firstCanvas.width);
		expect(webglCanvas.height).toBe(firstCanvas.height);
	});

	it("runs the heavy A+A chain for the quality tier when WebGPU cannot start", async () => {
		// Without WebGPU the two AI tiers used to run the same small chain; the quality tier now
		// runs the A+A (HQ) chain the WebGPU "quality" preset does, so they differ here too.
		drivers.anime4k.mockImplementationOnce(() => Promise.reject(new Error("no WebGPU")));
		mountComponent(UpscaleLayer, {
			props: { video: fakeVideo().video, mode: "anime4k-quality" },
		});
		await settle();

		expect(drivers.anime4kUltra).toHaveBeenCalledTimes(1);
		expect(drivers.anime4kWebGL).not.toHaveBeenCalled();
	});

	it("does not import the WebGPU driver when there is no usable adapter", async () => {
		// Firefox exposes navigator.gpu on every platform but hands out no adapter outside Windows
		// and Nightly; importing the driver to find that out would download 3.4 MB for nothing.
		drivers.probe.mockImplementation(() => Promise.resolve(false));
		mountComponent(UpscaleLayer, { props: { video: fakeVideo().video, mode: "anime4k" } });
		await settle();

		expect(drivers.anime4k).not.toHaveBeenCalled();
		expect(drivers.anime4kWebGL).toHaveBeenCalledTimes(1);
	});

	it("drops the quality tier to the fast preset before touching the scale", async () => {
		// The heavy chain is the first thing to give up: same upscale, about half the cost.
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k-quality" },
		});
		await settle();

		// The window that begins at a rebuild is skipped by design, and a step then needs two
		// consecutive bad windows on top of it, so 200 slow frames cover the whole decision.
		for (let i = 0; i < 200; i++) {
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

		for (let i = 0; i < 200; i++) {
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

	it("does not step down on the window that spans the rebuild", async () => {
		// A rebuild's own cost — linking the chain, the first frame, the layout settling —
		// lands in the window that begins with it, and judging that window would make the
		// ladder step down on a cost it just paid.
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		// The ladder writes the store, so it has to start from the tier under test.
		store.commit("settings/UPDATE", { upscaleMode: "sharpen" });
		await settle();

		// One window (6s) of 10fps, which the ladder skips because it began at a rebuild.
		for (let i = 0; i < 70; i++) {
			fire(100);
		}

		expect(store.state.settings.upscaleMode).toBe("sharpen");
		expect(store.state.settings.upscaleScale).toBe("auto");
	});

	it("still steps down when playback is genuinely slow", async () => {
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		// 10fps for longer than two windows: real, sustained slowness with no stall in it.
		for (let i = 0; i < 200; i++) {
			fire(100);
		}

		// The canvas is at the source resolution, and this box (1280x720 at dpr 1) is below
		// it, so one rung down is still above what the screen can show and the ladder may take
		// it. The floor itself is covered by the next test.
		expect(store.state.settings.upscaleScale).toBe(0.75);
	});

	it("waits for a second bad window before stepping down", async () => {
		// A single bad window is a hiccup — another app taking the GPU, a heavy scene — and
		// taking the viewer's tier away for it is what made the ladder feel trigger-happy.
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		// 10fps for two windows: the rebuild's window is skipped, so one verdict has landed.
		for (let i = 0; i < 130; i++) {
			fire(100);
		}
		expect(store.state.settings.upscaleScale).toBe("auto");

		// One more bad window confirms it, and the ladder steps.
		for (let i = 0; i < 60; i++) {
			fire(100);
		}
		expect(store.state.settings.upscaleScale).toBe(0.75);
	});

	it("steps down when the device presents one frame per second", async () => {
		// A renderer that far behind presents one frame per second instead of stopping, and its
		// media clock keeps running. Resetting the window on every such gap (as the stall check
		// used to) meant a tier at 0.9 fps never reached six seconds and never stepped down: the
		// heavy AI chain stayed on screen at one frame per second for as long as the viewer left
		// it there. Measured on an Intel UHD: HQ at 1080p, 916 ms per frame.
		const { video, fire } = fakeVideo();
		drivers.probe.mockImplementationOnce(() => Promise.resolve(false));
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k" },
		});
		store.commit("settings/UPDATE", { upscaleMode: "anime4k" });
		await settle();

		// Two long gaps after the rebuild's own first one, which is discounted.
		for (let i = 0; i < 3; i++) {
			fire(1100);
		}

		expect(store.state.settings.upscaleMode).toBe("film");
	});

	it("leaves the tier alone when a playing video simply stopped presenting", async () => {
		// The other long gap: the decoder has nothing, so the media clock is frozen too and the
		// element reports it through `readyState`. That is a rebuffer, not a slow renderer.
		const { video, fire } = fakeVideo();
		drivers.probe.mockImplementationOnce(() => Promise.resolve(false));
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k" },
		});
		store.commit("settings/UPDATE", { upscaleMode: "anime4k" });
		await settle();
		Object.defineProperty(video, "readyState", { value: 1, configurable: true });

		for (let i = 0; i < 6; i++) {
			// A long gap whose media clock did not advance either.
			fire(1500, 0);
		}

		expect(store.state.settings.upscaleMode).toBe("anime4k");
	});

	it("keeps a WebGL2 CNN tier at the displayed size instead of the 1.25x floor", async () => {
		// The floor pushes the target 4% past Anime4K's 1.2x gate, which turns on the x2 stage and
		// renders every remaining pass at twice the source. The WebGPU presets can pay for that;
		// the WebGL2 fallback measured 83 ms/frame for S and 916 ms/frame for HQ on an Intel UHD.
		const { video } = fakeVideo();
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
		drivers.probe.mockImplementationOnce(() => Promise.resolve(false));
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k" },
		});
		await settle();

		expect(drivers.anime4kWebGL).toHaveBeenCalledTimes(1);
		// 1920x1080 source in a 1280x720 box: "auto" clamps up to 1x, and the floor is not added.
		expect(wrapper.find("canvas").element.width).toBe(1920);
	});

	it("lets the WebGPU preset supersample past the CNN gate", async () => {
		const { video } = fakeVideo();
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k" },
		});
		await settle();

		expect(drivers.anime4k).toHaveBeenCalledTimes(1);
		expect(wrapper.find("canvas").element.width).toBe(2400);
	});

	it("names the integrated GPU in the degrade notice", async () => {
		// A viewer on a hybrid laptop sees "reduced" and has no idea why; the browser cannot be
		// moved to the other adapter from the page, so the notice has to name the cause.
		adapterState.current = {
			class: "integrated",
			renderer: "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0)",
		};
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, { props: { video, mode: "sharpen" } });
		await settle();

		for (let i = 0; i < 200; i++) {
			fire(100);
		}

		expect(store.state.settings.upscaleScale).not.toBe("auto");
		const notices = (
			store.state as unknown as { toast: { notifications: { content: string }[] } }
		).toast.notifications;
		expect(notices.map(n => n.content).join(" ")).toContain("核显");
		adapterState.current = { class: "unknown", renderer: null };
	});

	it("does not step down for the seeks a room does while watching", async () => {
		// Room-sync hard seeks, other viewers' seeks and manual drags all move `currentTime`,
		// and the media clock jumps with it. Counting that jump as frames the renderer never
		// presented used to step the tier down for something it had no part in.
		const { video, fire, seekBy } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		// Healthy 30fps with a hard seek every three seconds — a room whose sync keeps
		// correcting itself, or a viewer scrubbing. Every window holds a jump in it.
		for (let round = 0; round < 10; round++) {
			for (let i = 0; i < 90; i++) {
				fire(33);
			}
			seekBy(3);
		}
		for (let i = 0; i < 400; i++) {
			fire(33);
		}

		expect(store.state.settings.upscaleScale).toBe("auto");
	});

	it("ignores what the frames do while the tab is hidden", async () => {
		// A background tab is throttled by the browser, and nobody is looking at the picture:
		// the ladder must not strip the tier for frames the viewer never saw.
		const { video, fire } = fakeVideo();
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		Object.defineProperty(document, "hidden", { value: true, configurable: true });
		try {
			for (let i = 0; i < 300; i++) {
				fire(200);
			}
			expect(store.state.settings.upscaleScale).toBe("auto");
		} finally {
			Reflect.deleteProperty(document, "hidden");
		}

		// Back on screen at 30fps: still nothing to step down for.
		for (let i = 0; i < 400; i++) {
			fire(33);
		}
		expect(store.state.settings.upscaleScale).toBe("auto");
	});

	it("ends the ladder at the display box instead of rendering below the source", async () => {
		// A canvas below both the source and the display box is softer than the plain video —
		// the shader's single tap filtering loses to the browser's multi-tap scaler — so the
		// last rung is to turn the enhancement off, not to keep shrinking.
		const { video, fire } = fakeVideo();
		// A box larger than the 1080p source: nothing below 1x can be justified here.
		resizeVideo(video, 2560, 1440);
		const { store } = mountComponent(UpscaleLayer, {
			props: { video, mode: "sharpen" },
		});
		await settle();

		for (let i = 0; i < 400; i++) {
			fire(100);
		}

		expect(store.state.settings.upscaleMode).toBe("off");
		expect(store.state.settings.upscaleScale).toBe(1);
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

	/**
	 * The media element's own `resize` event, which is what an HLS ladder does when it
	 * switches variant: `videoWidth/videoHeight` change with no new resource and no window
	 * resize. The Anime4K presets read that size once, so nothing rebuilt the pipeline and
	 * the larger picture was cropped to the old canvas' top-left corner.
	 */
	function switchVariant(video: HTMLVideoElement, width: number, height: number) {
		Object.defineProperties(video, {
			videoWidth: { value: width, configurable: true },
			videoHeight: { value: height, configurable: true },
		});
		video.dispatchEvent(new Event("resize"));
	}

	it("rebuilds a WebGPU CNN when the source resolution changes without a resize", async () => {
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		mountComponent(UpscaleLayer, { props: { video, mode: "anime4k" } });
		await settle();
		expect(drivers.anime4k).toHaveBeenCalledTimes(1);

		switchVariant(video, 1920, 1080);
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(drivers.anime4k).toHaveBeenCalledTimes(2);
	});

	it("ignores a resize that reports the size the pipeline was built for", async () => {
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		mountComponent(UpscaleLayer, { props: { video, mode: "anime4k" } });
		await settle();

		// Same dimensions: a rebuild here would only cost a device and a pipeline.
		switchVariant(video, 1280, 720);
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(drivers.anime4k).toHaveBeenCalledTimes(1);
	});

	it("does not rebuild a sharpen pass whose size is read every frame", async () => {
		const { video } = fakeVideo();
		mountComponent(UpscaleLayer, { props: { video, mode: "sharpen" } });
		await settle();

		switchVariant(video, 640, 360);
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(drivers.sharpen).toHaveBeenCalledTimes(1);
	});

	it("rebuilds the AI tier at the displayed size when the viewport changes", async () => {
		const { video } = fakeVideo();
		mountComponent(UpscaleLayer, { props: { video, mode: "anime4k" } });
		await settle();
		expect(drivers.anime4k).toHaveBeenCalledTimes(1);
		const firstCanvas = drivers.anime4k.mock.calls[0][1] as HTMLCanvasElement;
		// The rebuild reuses this canvas, so its size has to be read now rather than later.
		const firstSize = [firstCanvas.width, firstCanvas.height];

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
		// The same canvas, resized for the new box.
		expect(secondCanvas).toBe(firstCanvas);
		expect(secondCanvas.width).toBeGreaterThan(firstSize[0]);
		expect(secondCanvas.height).toBeGreaterThan(firstSize[1]);
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

	it("resizes a WebGL CNN in place when the viewport changes", async () => {
		// The WebGL2 chains read the canvas size every frame and re-plan for it, so a viewport
		// change is a canvas resize — not a reason to delete a context and re-link the whole
		// chain (55 programs for the HQ tier). Rebuilding there froze the picture once per
		// fullscreen toggle and once per window drag.
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		const live = renderer();
		drivers.anime4kUltra.mockReturnValueOnce(live);
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k-ultra" },
		});
		await settle();
		const canvas = wrapper.find("canvas").element as HTMLCanvasElement;
		const before = [canvas.width, canvas.height];

		resizeVideo(video, 2560, 1440);
		window.dispatchEvent(new Event("resize"));
		await settle();
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(drivers.anime4kUltra).toHaveBeenCalledTimes(1);
		expect(canvas.width).toBeGreaterThan(before[0]);
		expect(live.redraw).toHaveBeenCalled();
	});

	it("resizes a WebGL CNN in place when the source rendition changes", async () => {
		// An HLS/DASH ladder switch changes videoWidth/videoHeight without a window resize. The
		// WebGL2 chain re-plans per frame, so this must not tear down the pipeline: every
		// variant switch would otherwise re-link the chain and restart the frame loop.
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		const live = renderer();
		drivers.anime4kUltra.mockReturnValueOnce(live);
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k-ultra" },
		});
		await settle();
		const canvas = wrapper.find("canvas").element as HTMLCanvasElement;

		switchVariant(video, 1920, 1080);
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(drivers.anime4kUltra).toHaveBeenCalledTimes(1);
		expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
		expect(live.redraw).toHaveBeenCalled();
	});

	it("keeps the AI tier on its WebGL2 fallback across a viewport change", async () => {
		// On the machines the AI tiers fall back on (no usable WebGPU), the running pipeline is
		// a WebGL2 chain and therefore resizable in place. Deciding by tier name alone would
		// rebuild the S / HQ chain here — the very case this fallback exists to serve.
		drivers.probe.mockImplementation(() => Promise.resolve(false));
		const { video } = fakeVideo();
		Object.defineProperties(video, {
			paused: { value: true },
			videoWidth: { value: 1280 },
			videoHeight: { value: 720 },
		});
		const live = renderer();
		drivers.anime4kWebGL.mockReturnValueOnce(live);
		const { wrapper } = mountComponent(UpscaleLayer, {
			props: { video, mode: "anime4k" },
		});
		await settle();
		expect(drivers.anime4kWebGL).toHaveBeenCalledTimes(1);
		const canvas = wrapper.find("canvas").element as HTMLCanvasElement;
		const before = [canvas.width, canvas.height];

		resizeVideo(video, 2560, 1440);
		window.dispatchEvent(new Event("resize"));
		await settle();
		await new Promise(resolve => setTimeout(resolve, 300));
		await settle();

		expect(drivers.anime4kWebGL).toHaveBeenCalledTimes(1);
		expect(canvas.width).toBeGreaterThan(before[0]);
		expect(live.redraw).toHaveBeenCalled();
	});
});
