/// <reference types="@webgpu/types" />
/* global GPUAdapter, GPUDevice */

// Whether this browser can actually run the WebGPU tiers.
//
// `"gpu" in navigator` only says the interface exists: Firefox exposes it on every platform but
// hands out no adapter outside Windows and Nightly, and a blocklisted driver behaves the same.
// An adapter on its own is not enough either — Firefox's Windows builds hand out devices that
// cannot write an rgba16float storage texture, which is the one thing every Anime4K pipeline
// does, and that draw a misplaced, blurry layer on top of the video instead of failing. The probe
// runs the smallest version of that pipeline and reads the value back.
//
// The frame upload has to be probed as well: Firefox's WebGPU rejects an HTMLVideoElement (and a
// VideoFrame) as a copyExternalImageToTexture source, so the driver would build a whole device and
// pipeline and then throw on the very first frame, falling back anyway. The probe copies one real
// frame into a 1x1 texture to find that out before the driver is imported.
//
// Finding any of this out by starting the WebGPU driver costs a 3.4 MB chunk, so none of it is
// downloaded until the probe says yes.

/** The pattern the probe pushes through the GPU, as IEEE 754 half-precision bit patterns. */
const FIRST = 0x5400; // 64.0
const SECOND = 0x5c00; // 192.0
const ONE = 0x3c00; // 1.0
const PROBE_TIMEOUT = 2000;
/** How long the frame-upload test waits for the video to present its first frame. */
const FRAME_WAIT_MS = 4000;
/** HTMLMediaElement.HAVE_CURRENT_DATA: a frame is decoded and available to copy. */
const HAVE_CURRENT_DATA = 2;
let probe: Promise<boolean> | undefined;

/**
 * "unsupported" is final for the session; "inconclusive" means the video had no frame to test
 * the upload with yet, so the tiers are not ruled out but the answer must not be cached.
 */
type ProbeOutcome = "ok" | "unsupported" | "inconclusive";

async function requestAdapter(): Promise<GPUAdapter | null> {
	if (!("gpu" in navigator)) {
		return null;
	}
	try {
		// Some implementations only hand out an adapter when performance is requested.
		return (
			(await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ??
			(await navigator.gpu.requestAdapter()) ??
			null
		);
	} catch {
		// Firefox throws on platforms where WebGPU is not enabled at all.
		return null;
	}
}

/**
 * Runs the shape every Anime4K pipeline has — sampling a texture at integer coordinates and
 * writing the value into an rgba16float storage texture — and checks the values come back in
 * order. Anything short of that means the tiers would draw a blurry, misplaced layer rather than
 * fail, so they are not offered.
 */
async function canWriteStorageTexture(device: GPUDevice): Promise<boolean> {
	// WebGPU reports this kind of failure through the error scope rather than by throwing.
	device.pushErrorScope("validation");
	// The shape every Anime4K pipeline has: read a texture at integer coordinates, write the
	// value into an rgba16float storage texture. Two texels is enough to notice a device that
	// returns them in the wrong order, which is what a shifted picture looks like.
	const source = device.createTexture({
		size: [2, 1],
		format: "rgba16float",
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	// 64 and 192 in the red channel, 1.0 in alpha, as half-precision bit patterns.
	device.queue.writeTexture(
		{ texture: source },
		new Uint16Array([FIRST, 0, 0, ONE, SECOND, 0, 0, ONE]),
		{ bytesPerRow: 16 },
		{ width: 2, height: 1 },
	);
	const destination = device.createTexture({
		size: [2, 1],
		format: "rgba16float",
		usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
	});
	const pipeline = device.createComputePipeline({
		layout: "auto",
		compute: {
			module: device.createShaderModule({
				// `target` is a reserved word in WGSL; the names here are arbitrary.
				code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(2, 1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let value = textureLoad(source, vec2<i32>(id.xy), 0);
	textureStore(destination, vec2<i32>(id.xy), value);
}`,
			}),
			entryPoint: "main",
		},
	});
	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: source.createView() },
			{ binding: 1, resource: destination.createView() },
		],
	});
	const readback = device.createBuffer({
		size: 256,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bindGroup);
	pass.dispatchWorkgroups(1);
	pass.end();
	encoder.copyTextureToBuffer(
		{ texture: destination },
		{ buffer: readback, bytesPerRow: 256 },
		{ width: 2, height: 1 },
	);
	device.queue.submit([encoder.finish()]);

	const error = await device.popErrorScope();
	if (error) {
		return false;
	}
	// A device whose GPU process is gone leaves mapAsync pending forever.
	const mapped = await Promise.race([
		readback.mapAsync(GPUMapMode.READ).then(() => true),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), PROBE_TIMEOUT)),
	]);
	if (!mapped) {
		return false;
	}
	// The texels have to come back in the order they went in, with the values intact.
	// Reading them has to happen before unmap(), which detaches the view.
	const words = new Uint16Array(readback.getMappedRange(), 0, 8);
	const first = words[0];
	const second = words[4];
	readback.unmap();
	return first === FIRST && second === SECOND;
}

/** Waits for the video to present a frame, so the copy test below has something to copy. */
function waitForFrame(video: HTMLVideoElement): Promise<boolean> {
	if (video.readyState >= HAVE_CURRENT_DATA) {
		return Promise.resolve(true);
	}
	return new Promise<boolean>(resolve => {
		const settle = (ready: boolean) => {
			clearTimeout(timer);
			video.removeEventListener("loadeddata", onLoaded);
			resolve(ready);
		};
		const onLoaded = () => settle(true);
		const timer = setTimeout(() => settle(false), FRAME_WAIT_MS);
		video.addEventListener("loadeddata", onLoaded, { once: true });
	});
}

/**
 * Copies one real frame of the video into a 1x1 texture. Firefox's WebGPU rejects an
 * HTMLVideoElement (and a VideoFrame) as an external image source, so without this the driver
 * would build a device and pipeline and then throw on the first frame.
 */
async function canUploadVideo(device: GPUDevice, video: HTMLVideoElement): Promise<boolean> {
	device.pushErrorScope("validation");
	try {
		const target = device.createTexture({
			size: [1, 1],
			format: "rgba8unorm",
			usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
		});
		device.queue.copyExternalImageToTexture({ source: video }, { texture: target }, [1, 1]);
	} catch {
		// A source the browser will not convert is a synchronous TypeError, not an error-scope
		// result, so it has to be caught here.
		await device.popErrorScope();
		return false;
	}
	return (await device.popErrorScope()) === null;
}

/** Runs both capability shapes on a single device, then frees it. */
async function probeDevice(adapter: GPUAdapter, video?: HTMLVideoElement): Promise<ProbeOutcome> {
	let device: GPUDevice | undefined;
	try {
		device = await adapter.requestDevice();
		if (!(await canWriteStorageTexture(device))) {
			return "unsupported";
		}
		if (video) {
			if (!(await waitForFrame(video))) {
				return "inconclusive";
			}
			if (!(await canUploadVideo(device, video))) {
				return "unsupported";
			}
		}
		return "ok";
	} catch {
		return "unsupported";
	} finally {
		device?.destroy();
	}
}

/**
 * Whether the WebGPU tiers can run here, optionally also checking that this video's frames can be
 * uploaded at all. Caching follows the same rule as before: a definite failure is never cached (a
 * transient driver reset should be retried) and a definite success is. An inconclusive pass lets
 * this start proceed but is not cached, so the next start still gets to judge it.
 */
export function canRunWebGPUEnhancement(video?: HTMLVideoElement): Promise<boolean> {
	probe ??= (async () => {
		const adapter = await requestAdapter();
		if (!adapter) {
			probe = undefined;
			return false;
		}
		const outcome = await probeDevice(adapter, video);
		if (outcome !== "ok") {
			probe = undefined;
		}
		return outcome !== "unsupported";
	})();
	return probe;
}
