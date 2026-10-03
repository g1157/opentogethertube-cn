import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	audioEqSourceBlocked,
	useMediaAudioBoost,
} from "../../src/components/composables/media-audio-boost";
import { AUDIO_EQ_BANDS_HZ, AUDIO_EQ_SPECS } from "../../src/util/audio-eq";

interface FakeGain {
	gain: { value: number };
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
}

interface FakeFilter {
	type: string;
	frequency: { value: number };
	Q: { value: number };
	gain: { value: number };
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
}

describe("useMediaAudioBoost", () => {
	const originalWarn = console.warn;

	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		audioEqSourceBlocked.value = false;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		console.warn = originalWarn;
		audioEqSourceBlocked.value = false;
	});

	function makeContext(options?: { state?: AudioContextState; throwOnSource?: boolean }) {
		const gains: FakeGain[] = [];
		const filters: FakeFilter[] = [];
		const source = { connect: vi.fn(), disconnect: vi.fn() };
		const createGain = vi.fn(() => {
			const node: FakeGain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
			gains.push(node);
			return node;
		});
		const createBiquadFilter = vi.fn(() => {
			const node: FakeFilter = {
				type: "",
				frequency: { value: 0 },
				Q: { value: 0 },
				gain: { value: 0 },
				connect: vi.fn(),
				disconnect: vi.fn(),
			};
			filters.push(node);
			return node;
		});
		const context = {
			state: options?.state ?? "running",
			createGain,
			createBiquadFilter,
			createMediaElementSource: vi.fn(() => {
				if (options?.throwOnSource) {
					throw new Error("source failed");
				}
				return source;
			}),
			destination: {} as AudioDestinationNode,
			close: vi.fn(async () => undefined),
			resume: vi.fn(async () => undefined),
		} as unknown as AudioContext;

		return { context, gains, filters, source };
	}

	function setRoutable(video: HTMLVideoElement, routable: boolean) {
		// jsdom reflects crossOrigin loosely ("" once the attribute is gone, "null" for a
		// null assignment), so the test pins the value the browser would report.
		Object.defineProperty(video, "crossOrigin", {
			value: routable ? "anonymous" : null,
			configurable: true,
		});
	}

	function mountComposable(createContext: () => AudioContext, options?: { routable?: boolean }) {
		let api: ReturnType<typeof useMediaAudioBoost> | undefined;
		const elementKey = ref(0);

		const wrapper = mount(
			defineComponent({
				setup() {
					const mediaElement = ref<HTMLVideoElement>();
					api = useMediaAudioBoost(mediaElement, createContext);
					return { mediaElement, elementKey };
				},
				template:
					'<video :key="elementKey" ref="mediaElement" crossorigin="anonymous"></video>',
			}),
		);

		if (!api) {
			throw new Error("Failed to initialize audio boost composable");
		}

		const video = wrapper.find("video").element as HTMLVideoElement;
		if (options?.routable === false) {
			setRoutable(video, false);
		}

		return {
			wrapper,
			api,
			elementKey,
			video: () => wrapper.find("video").element as HTMLVideoElement,
		};
	}

	async function settle() {
		await nextTick();
		await nextTick();
	}

	it("does not create the graph on init or at 100% boost", () => {
		const { context } = makeContext();
		const factory = vi.fn(() => context);
		const { api } = mountComposable(factory);

		expect(factory).toHaveBeenCalledTimes(1);
		expect(api.source.value).toBeUndefined();
		expect(api.gain.value).toBeUndefined();

		api.setBoost(100);

		expect(context.createMediaElementSource).not.toHaveBeenCalled();
		expect(context.createGain).not.toHaveBeenCalled();
		expect(context.createBiquadFilter).not.toHaveBeenCalled();
		expect(api.source.value).toBeUndefined();
		expect(api.gain.value).toBeUndefined();
	});

	it("builds the fixed chain once, clamps boost up to 300%, and resets to unity", () => {
		const { context, gains, filters, source } = makeContext();
		const { api } = mountComposable(() => context);

		api.setBoost(250);
		api.setBoost(350);

		expect(gains).toHaveLength(2);
		const [preamp, boost] = gains;
		expect(boost.gain.value).toBe(3);

		api.setBoost(100);

		expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
		expect(context.createGain).toHaveBeenCalledTimes(2);
		expect(context.createBiquadFilter).toHaveBeenCalledTimes(AUDIO_EQ_BANDS_HZ.length);
		expect(boost.gain.value).toBe(1);
		// The chain is source → filters → preamp → boost → destination.
		expect(source.connect).toHaveBeenCalledWith(filters[0]);
		for (let i = 0; i < filters.length - 1; i++) {
			expect(filters[i].connect).toHaveBeenCalledWith(filters[i + 1]);
		}
		expect(filters[filters.length - 1].connect).toHaveBeenCalledWith(preamp);
		expect(preamp.connect).toHaveBeenCalledWith(boost);
		expect(boost.connect).toHaveBeenCalledWith(context.destination);
		expect(filters.map(filter => filter.frequency.value)).toEqual([...AUDIO_EQ_BANDS_HZ]);
		expect(filters.every(filter => filter.type === "peaking")).toBe(true);
		expect(filters.every(filter => filter.Q.value === 1)).toBe(true);
	});

	it("writes preset bands and preamp, and zeroes them back for off", () => {
		const { context, gains, filters } = makeContext();
		const { api } = mountComposable(() => context);

		api.setEq("bass");

		const [preamp] = gains;
		expect(filters.map(filter => filter.gain.value)).toEqual([...AUDIO_EQ_SPECS.bass.bands]);
		expect(preamp.gain.value).toBeCloseTo(10 ** (AUDIO_EQ_SPECS.bass.preampDb / 20), 5);

		api.setEq("off");

		expect(filters.map(filter => filter.gain.value)).toEqual(AUDIO_EQ_BANDS_HZ.map(() => 0));
		expect(preamp.gain.value).toBe(1);
		// Turning the preset off does not rebuild anything: the equipment stays attached.
		expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
	});

	it("refuses to reach Web Audio for a source that cannot be routed, and says so", () => {
		const { context } = makeContext();
		const { api, video } = mountComposable(() => context, { routable: false });

		api.setEq("bass");
		api.setBoost(200);

		expect(context.createMediaElementSource).not.toHaveBeenCalled();
		expect(audioEqSourceBlocked.value).toBe(true);

		// Once the element loads in CORS mode, a reset lets the settings apply again.
		setRoutable(video(), true);
		api.resetFailedSetup();
		api.setEq("bass");

		expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
		expect(audioEqSourceBlocked.value).toBe(false);
	});

	it("rebuilds the graph for a replaced element and re-applies the remembered settings", async () => {
		const { context, gains } = makeContext();
		const { api, elementKey } = mountComposable(() => context);

		// Let the initial ref binding flush so its watch cannot rebuild behind the counts.
		await settle();

		api.setBoost(200);
		expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);

		elementKey.value++;
		await settle();

		// The old element takes its graph with it; the new one gets the same settings.
		expect(context.createMediaElementSource).toHaveBeenCalledTimes(2);
		const boost = gains[gains.length - 1];
		expect(boost.gain.value).toBe(2);
	});

	it("resumes suspended contexts and disconnects on unmount", () => {
		const { context, gains, filters, source } = makeContext({ state: "suspended" });
		const { api, wrapper } = mountComposable(() => context);

		api.setBoost(200);
		wrapper.unmount();

		expect(context.resume).toHaveBeenCalledTimes(1);
		expect(source.disconnect).toHaveBeenCalledTimes(1);
		expect(filters.every(filter => filter.disconnect.mock.calls.length === 1)).toBe(true);
		expect(gains.every(gain => gain.disconnect.mock.calls.length === 1)).toBe(true);
		expect(context.close).toHaveBeenCalledTimes(1);
	});

	it("fails gracefully and stops retrying until reset", () => {
		const { context } = makeContext({ throwOnSource: true });
		const { api } = mountComposable(() => context);

		expect(() => api.setBoost(200)).not.toThrow();
		expect(() => api.setBoost(300)).not.toThrow();

		expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalled();
	});

	it("can retry setup after a failed source change", () => {
		let shouldThrow = true;
		const { context, gains } = makeContext();
		vi.spyOn(context, "createMediaElementSource").mockImplementation(() => {
			if (shouldThrow) {
				throw new Error("source failed");
			}
			return {
				connect: vi.fn(),
				disconnect: vi.fn(),
			} as unknown as MediaElementAudioSourceNode;
		});
		const { api } = mountComposable(() => context);

		expect(() => api.setBoost(200)).not.toThrow();
		shouldThrow = false;
		api.resetFailedSetup();
		api.setBoost(200);

		expect(context.createMediaElementSource).toHaveBeenCalledTimes(2);
		expect(gains[gains.length - 1].gain.value).toBe(2);
	});
});
