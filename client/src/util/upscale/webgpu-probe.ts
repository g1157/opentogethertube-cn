/// <reference types="@webgpu/types" />
/* global GPUAdapter, GPUDevice */
import { ref } from "vue";

// Whether this browser can actually run the WebGPU tiers.
//
// `"gpu" in navigator` only says the interface exists: Firefox exposes it on every platform but
// hands out no adapter outside Windows and Nightly, and a blocklisted driver behaves the same.
// An adapter on its own is not enough either — Firefox's Windows builds hand out devices that
// cannot write an rgba16float storage texture, which is the one thing every Anime4K pipeline
// does. The tiers then draw a misplaced, blurry layer on top of the video instead of failing, so
// the probe runs the smallest version of that pipeline and reads the value back.
//
// Finding all this out by starting the WebGPU driver costs a 3.4 MB chunk, so none of it is
// downloaded until the probe says yes.

/** The pattern the probe pushes through the GPU, as IEEE 754 half-precision bit patterns. */
const FIRST = 0x5400; // 64.0
const SECOND = 0x5c00; // 192.0
const ONE = 0x3c00; // 1.0
const PROBE_TIMEOUT = 2000;
let probe: Promise<boolean> | undefined;

/**
 * Reactive for the settings menu: null until the probe has run. A device can pass every probe and
 * still draw the wrong picture (Firefox's WebGPU did exactly that), so this also flips to false
 * when the first rendered frame turns out not to be the video — see `markWebGPUPathBroken`.
 */
export const webgpuUsable = ref<boolean | null>(null);

let brokenReason: string | null = null;

/**
 * Called when a started WebGPU renderer is caught drawing something that is not the video. From
 * then on nothing offers the WebGPU path again, so the next start takes the WebGL2 chain.
 */
export function markWebGPUPathBroken(reason: string): void {
	brokenReason = reason;
	probe = Promise.resolve(false);
	webgpuUsable.value = false;
}

export function webgpuBrokenReason(): string | null {
	return brokenReason;
}

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
async function canWriteStorageTexture(adapter: GPUAdapter): Promise<boolean> {
	let device: GPUDevice | undefined;
	try {
		device = await adapter.requestDevice();
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
	} catch {
		return false;
	} finally {
		device?.destroy();
	}
}

/**
 * Cached only when the whole probe succeeded: a viewer whose device failed transiently (a driver
 * reset, a slow GPU process) still gets the WebGPU tier on the next tier switch or video.
 */
export function canRunWebGPUEnhancement(): Promise<boolean> {
	if (brokenReason) {
		return Promise.resolve(false);
	}
	probe ??= requestAdapter().then(async adapter => {
		if (!adapter || !(await canWriteStorageTexture(adapter))) {
			probe = undefined;
			webgpuUsable.value = false;
			return false;
		}
		webgpuUsable.value = true;
		return true;
	});
	return probe;
}
