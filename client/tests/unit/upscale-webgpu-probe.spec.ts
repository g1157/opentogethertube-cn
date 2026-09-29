import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadProbe() {
	vi.resetModules();
	return await import("@/util/upscale/webgpu-probe");
}

function fakeGpu(requestAdapter: () => Promise<unknown>) {
	Object.defineProperty(navigator, "gpu", { value: { requestAdapter }, configurable: true });
}

/** The parts of a GPUDevice the probe touches, plus the texels its readback should report. */
function fakeDevice(
	options: { error?: unknown; words?: number[]; mapNever?: boolean; uploadError?: Error } = {},
) {
	const words = options.words ?? [0x5400, 0, 0, 0x3c00, 0x5c00, 0, 0, 0x3c00];
	const readback = {
		mapAsync: () =>
			options.mapNever ? new Promise<never>(() => undefined) : Promise.resolve(),
		// getMappedRange returns an ArrayBuffer, which the probe wraps in a typed view.
		getMappedRange: () => new Uint16Array(words).buffer,
		unmap: vi.fn(),
	};
	return {
		pushErrorScope: vi.fn(),
		// A validation error is how an implementation that cannot do this reports itself, rather
		// than by throwing.
		popErrorScope: vi.fn().mockResolvedValue(options.error ?? null),
		createTexture: vi.fn(() => ({ createView: () => ({}) })),
		createShaderModule: vi.fn(() => ({})),
		createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
		createBindGroup: vi.fn(() => ({})),
		createBuffer: vi.fn(() => readback),
		createCommandEncoder: vi.fn(() => ({
			beginComputePass: () => ({
				setPipeline: vi.fn(),
				setBindGroup: vi.fn(),
				dispatchWorkgroups: vi.fn(),
				end: vi.fn(),
			}),
			copyTextureToBuffer: vi.fn(),
			finish: () => ({}),
		})),
		queue: {
			submit: vi.fn(),
			writeTexture: vi.fn(),
			// Firefox's WebGPU throws here for an HTMLVideoElement (or a VideoFrame) source.
			copyExternalImageToTexture: options.uploadError
				? vi.fn(() => {
						throw options.uploadError;
					})
				: vi.fn(),
		},
		destroy: vi.fn(),
	};
}

const fakeAdapter = (device: unknown) => ({ requestDevice: vi.fn().mockResolvedValue(device) });

/** A video element whose decoded-frame readiness the frame-upload probe reads. */
function fakeVideo(readyState = 4) {
	const video = document.createElement("video");
	Object.defineProperty(video, "readyState", { value: readyState, configurable: true });
	return video;
}

/** The TypeError Firefox's WebGPU raises when it refuses a video as an external image source. */
function videoSourceTypeError() {
	return new TypeError(
		"GPUQueue.copyExternalImageToTexture: 'source' member of GPUCopyExternalImageSourceInfo " +
			"could not be converted to any of: ImageBitmap, HTMLImageElement, HTMLCanvasElement, " +
			"OffscreenCanvas.",
	);
}

describe("WebGPU enhancement probe", () => {
	beforeEach(() => {
		// The probe reads the WebGPU constants the way the browser exposes them.
		Object.assign(window, {
			GPUTextureUsage: { STORAGE_BINDING: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 },
			GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 },
			GPUMapMode: { READ: 1 },
		});
	});

	afterEach(() => {
		Reflect.deleteProperty(navigator, "gpu");
		for (const name of ["GPUTextureUsage", "GPUBufferUsage", "GPUMapMode"]) {
			Reflect.deleteProperty(window, name);
		}
		vi.useRealTimers();
		vi.resetModules();
	});

	it("reports no WebGPU when the interface is missing", async () => {
		const { canRunWebGPUEnhancement } = await loadProbe();
		expect(await canRunWebGPUEnhancement()).toBe(false);
	});

	it("reports no WebGPU when the browser hands out no adapter", async () => {
		const requestAdapter = vi.fn().mockResolvedValue(null);
		fakeGpu(requestAdapter);
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(false);
		// The high-performance preference is tried first, then the plain request.
		expect(requestAdapter).toHaveBeenCalledTimes(2);
	});

	it("treats a thrown request as no WebGPU", async () => {
		// Firefox throws here on the platforms where WebGPU is not enabled at all.
		fakeGpu(vi.fn().mockRejectedValue(new Error("WebGPU is only available on Windows")));
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(false);
	});

	it("reports no WebGPU when the device cannot write an rgba16float storage texture", async () => {
		// Firefox's Windows builds hand out a device and then reject the storage texture the
		// Anime4K pipelines are built on; the tiers would draw a blurry, misplaced layer.
		const device = fakeDevice({
			error: new Error("storage textures of that format are not supported"),
		});
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(device)));
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(false);
		expect(device.destroy).toHaveBeenCalled();
	});

	it("reports no WebGPU when the device cannot upload a video frame", async () => {
		// Firefox's WebGPU writes storage textures but rejects an HTMLVideoElement (and a
		// VideoFrame) as a copyExternalImageToTexture source, so every Anime4K frame would throw
		// at the first draw and fall back anyway.
		const device = fakeDevice({ uploadError: videoSourceTypeError() });
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(device)));
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement(fakeVideo())).toBe(false);
		expect(device.destroy).toHaveBeenCalled();
	});

	it("keeps WebGPU when the upload fails for a reason other than the source type", async () => {
		// A source without CORS, a validation error or a busy GPU process must not take the tiers
		// away: the driver gets its own chance and falls back if it really cannot run.
		const device = fakeDevice({ uploadError: new Error("OperationError: not origin-clean") });
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(device)));
		const { canRunWebGPUEnhancement, webgpuVideoUploadSupported } = await loadProbe();

		expect(await canRunWebGPUEnhancement(fakeVideo())).toBe(true);
		expect(webgpuVideoUploadSupported.value).toBe(null);
	});

	it("accepts a device that can upload a video frame", async () => {
		const device = fakeDevice();
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(device)));
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement(fakeVideo())).toBe(true);
	});

	it("publishes whether a video frame can be uploaded", async () => {
		const device = fakeDevice({ uploadError: videoSourceTypeError() });
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(device)));
		const { canRunWebGPUEnhancement, webgpuVideoUploadSupported } = await loadProbe();

		expect(webgpuVideoUploadSupported.value).toBe(null);
		expect(await canRunWebGPUEnhancement(fakeVideo())).toBe(false);
		expect(webgpuVideoUploadSupported.value).toBe(false);
	});

	it("does not cache a probe it could not finish without a frame", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const requestAdapter = vi.fn().mockResolvedValue(fakeAdapter(fakeDevice()));
		fakeGpu(requestAdapter);
		const { canRunWebGPUEnhancement } = await loadProbe();

		// A video that has decoded nothing yet gives the upload shape nothing to copy.
		const pending = canRunWebGPUEnhancement(fakeVideo(0));
		await vi.advanceTimersByTimeAsync(5000);
		expect(await pending).toBe(true);
		// It must be probed again rather than trusting a shape it never tested. The storage shape
		// was answered on the first call and is cached, so the extra requests are the two upload
		// attempts (the timed-out one and the one that finally had a frame).
		expect(await canRunWebGPUEnhancement(fakeVideo())).toBe(true);
		expect(requestAdapter).toHaveBeenCalledTimes(3);
	});

	it("reports no WebGPU when the values do not come back", async () => {
		fakeGpu(
			vi.fn().mockResolvedValue(fakeAdapter(fakeDevice({ words: new Array(8).fill(0) }))),
		);
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(false);
	});

	it("reports no WebGPU when the texels come back in the wrong order", async () => {
		// What a device whose coordinates are off looks like: the pattern survives, shifted.
		const swapped = [0x5c00, 0, 0, 0x3c00, 0x5400, 0, 0, 0x3c00];
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(fakeDevice({ words: swapped }))));
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(false);
	});

	it("gives up on a device that never maps its readback", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fakeGpu(vi.fn().mockResolvedValue(fakeAdapter(fakeDevice({ mapNever: true }))));
		const { canRunWebGPUEnhancement } = await loadProbe();

		const result = canRunWebGPUEnhancement();
		await vi.advanceTimersByTimeAsync(2500);
		expect(await result).toBe(false);
	});

	it("caches a working device so later tier switches do not re-probe", async () => {
		const requestDevice = vi.fn().mockResolvedValue(fakeDevice());
		const requestAdapter = vi.fn().mockResolvedValue({ requestDevice });
		fakeGpu(requestAdapter);
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(true);
		expect(await canRunWebGPUEnhancement()).toBe(true);
		expect(requestAdapter).toHaveBeenCalledTimes(1);
	});

	it("probes again after a failure instead of caching it", async () => {
		const requestAdapter = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(fakeAdapter(fakeDevice()));
		fakeGpu(requestAdapter);
		const { canRunWebGPUEnhancement } = await loadProbe();

		expect(await canRunWebGPUEnhancement()).toBe(false);
		expect(await canRunWebGPUEnhancement()).toBe(true);
	});
});
