import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const rect = {
	width: 640,
	height: 360,
	x: 0,
	y: 0,
	top: 0,
	left: 0,
	right: 640,
	bottom: 360,
	toJSON: () => ({}),
} as DOMRect;

function makeVideo() {
	const video = document.createElement("video");
	const state = { paused: false, currentTime: 0 };
	Object.defineProperties(video, {
		paused: { configurable: true, get: () => state.paused },
		currentTime: { configurable: true, get: () => state.currentTime },
		videoWidth: { configurable: true, get: () => 640 },
		videoHeight: { configurable: true, get: () => 360 },
		getBoundingClientRect: { configurable: true, value: () => rect },
	});
	return { video, state };
}

describe("danmaku layer frame loop", () => {
	let rafCallbacks: Map<number, FrameRequestCallback>;
	let rafNextId: number;
	let drawCount: number;
	let contextRequests: unknown[][];
	let context: {
		setTransform: ReturnType<typeof vi.fn>;
		clearRect: ReturnType<typeof vi.fn>;
		strokeText: ReturnType<typeof vi.fn>;
		fillText: ReturnType<typeof vi.fn>;
		measureText: ReturnType<typeof vi.fn>;
		globalAlpha: number;
		font: string;
		textBaseline: string;
		lineJoin: string;
		strokeStyle: string;
		lineWidth: number;
		fillStyle: string;
	};

	beforeEach(() => {
		rafCallbacks = new Map();
		rafNextId = 0;
		drawCount = 0;
		contextRequests = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			rafCallbacks.set(++rafNextId, callback);
			return rafNextId;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			rafCallbacks.delete(id);
		});
		context = {
			setTransform: vi.fn(),
			clearRect: vi.fn(() => {
				drawCount++;
			}),
			strokeText: vi.fn(),
			fillText: vi.fn(),
			measureText: vi.fn(() => ({ width: 10 })),
			globalAlpha: 1,
			font: "",
			textBaseline: "",
			lineJoin: "",
			strokeStyle: "",
			lineWidth: 1,
			fillStyle: "",
		};
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
			...args: unknown[]
		) => {
			contextRequests.push(args);
			return context as unknown as CanvasRenderingContext2D;
		}) as unknown as typeof HTMLCanvasElement.prototype.getContext);
	});

	/** X of the last text the layer drew; NaN when nothing has been drawn. */
	function lastDrawnX(): number {
		const calls = context.strokeText.mock.calls as [string, number, number][];
		return calls.length > 0 ? calls[calls.length - 1][1] : Number.NaN;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function runFrame() {
		const pending = [...rafCallbacks.values()];
		rafCallbacks.clear();
		for (const callback of pending) {
			callback(performance.now());
		}
	}

	async function mountLayer() {
		const { video, state } = makeVideo();
		const { wrapper, store } = mountComponent(DanmakuLayer, {
			props: { video, videoUrl: "/media/ep01.mp4" },
		});
		// Danmaku starts off by default now; this suite is about the layer itself.
		store.commit("settings/UPDATE_TRANSIENT", { danmakuEnabled: true });
		await flush();
		await nextTick();
		// The layer sizes itself from the video's box the way a ResizeObserver delivery
		// does in a browser; jsdom's stub never delivers that first observation.
		window.dispatchEvent(new Event("resize"));
		await nextTick();
		return { wrapper, video, state };
	}

	it("repaints on every animation frame while the media clock advances", async () => {
		// Regression: driving the loop from requestVideoFrameCallback capped the motion to
		// the source's frame rate — 24fps anime juddered on a 60Hz screen. The display
		// rate now decides how often the comments are repainted.
		const { state } = await mountLayer();
		expect(rafCallbacks.size).toBe(1);

		const before = drawCount;
		for (let i = 1; i <= 5; i++) {
			state.currentTime = i * 0.016;
			runFrame();
		}

		expect(drawCount - before).toBe(5);
		expect(rafCallbacks.size).toBe(1);
	});

	it("keeps a comment moving between media frames, then stops on a stalled picture", async () => {
		// Regression: video.currentTime steps once per presented frame (24fps anime -> 24
		// steps a second), so comments advanced in visible jumps on a 60/120Hz screen. The
		// clock extrapolates between anchors — and stops once its lead is capped, so a
		// stalled video cannot keep sliding comments over a frozen picture.
		const now = vi.spyOn(performance, "now");
		const { state } = await mountLayer();
		state.currentTime = 1;
		now.mockReturnValue(10_000);
		runFrame();
		const spawned = lastDrawnX();

		now.mockReturnValue(10_016);
		runFrame();
		expect(lastDrawnX()).toBeLessThan(spawned);

		// Far past the cap: one paint settles on the capped clock, then nothing moves.
		now.mockReturnValue(11_000);
		runFrame();
		const settled = drawCount;
		now.mockReturnValue(12_000);
		runFrame();
		expect(drawCount).toBe(settled);
		now.mockRestore();
	});

	it("stops the loop while paused and restarts on play", async () => {
		const { video, state } = await mountLayer();
		state.paused = true;
		runFrame();

		expect(rafCallbacks.size).toBe(0);

		state.paused = false;
		video.dispatchEvent(new Event("play"));

		expect(rafCallbacks.size).toBe(1);
	});

	it("moves the loop to a replacement element", async () => {
		const { wrapper, state } = await mountLayer();
		const second = makeVideo();
		second.state.paused = true;

		await wrapper.setProps({ video: second.video });
		await flush();
		await nextTick();

		// The old element's pending frame is released and the paused replacement does not
		// schedule one; resuming it starts the loop for the new element.
		expect(rafCallbacks.size).toBe(0);
		second.state.paused = false;
		second.video.dispatchEvent(new Event("play"));
		expect(rafCallbacks.size).toBe(1);
		expect(state.paused).toBe(false);
	});

	it("never asks for the low-latency 2d context", async () => {
		// Regression: Chromium composites a transparent canvas created with
		// { desynchronized: true } as opaque black on some Android GPUs (crbug 450752884).
		// On a real phone that covered the whole video with a black rectangle, while the
		// same link and the same page on a desktop browser rendered normally.
		await mountLayer();

		expect(contextRequests.length).toBeGreaterThan(0);
		for (const args of contextRequests) {
			expect((args[1] as { desynchronized?: boolean } | undefined)?.desynchronized).not.toBe(
				true,
			);
		}
	});
});
