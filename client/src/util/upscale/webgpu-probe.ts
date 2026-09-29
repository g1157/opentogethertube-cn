/// <reference types="@webgpu/types" />
/* global GPUAdapter */

// Whether this browser can actually run the WebGPU tiers.
//
// `"gpu" in navigator` only says the interface exists: Firefox exposes it on every platform but
// hands out no adapter outside Windows and Nightly, and a blocklisted driver behaves the same.
// Finding that out by starting the WebGPU driver costs a 3.4 MB chunk, so ask for an adapter
// first and only download the driver when one shows up.

let probe: Promise<boolean> | undefined;

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
 * Cached only when an adapter exists: a viewer whose request failed transiently (a driver reset,
 * a slow GPU process) still gets the WebGPU tier on the next tier switch or video.
 */
export function hasUsableWebGPUAdapter(): Promise<boolean> {
	probe ??= requestAdapter().then(adapter => {
		if (!adapter) {
			probe = undefined;
			return false;
		}
		return true;
	});
	return probe;
}
