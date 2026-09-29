import { afterEach, describe, expect, it, vi } from "vitest";

async function loadProbe() {
	vi.resetModules();
	return await import("@/util/upscale/webgpu-probe");
}

function fakeGpu(requestAdapter: () => Promise<unknown>) {
	Object.defineProperty(navigator, "gpu", { value: { requestAdapter }, configurable: true });
}

describe("WebGPU adapter probe", () => {
	afterEach(() => {
		Reflect.deleteProperty(navigator, "gpu");
		vi.resetModules();
	});

	it("reports no adapter when the interface is missing", async () => {
		const { hasUsableWebGPUAdapter } = await loadProbe();
		expect(await hasUsableWebGPUAdapter()).toBe(false);
	});

	it("reports no adapter when the browser hands out none", async () => {
		const requestAdapter = vi.fn().mockResolvedValue(null);
		fakeGpu(requestAdapter);
		const { hasUsableWebGPUAdapter } = await loadProbe();

		expect(await hasUsableWebGPUAdapter()).toBe(false);
		// The high-performance preference is tried first, then the plain request.
		expect(requestAdapter).toHaveBeenCalledTimes(2);
	});

	it("treats a thrown request as no adapter", async () => {
		// Firefox throws here on the platforms where WebGPU is not enabled at all.
		fakeGpu(vi.fn().mockRejectedValue(new Error("WebGPU is only available on Windows")));
		const { hasUsableWebGPUAdapter } = await loadProbe();

		expect(await hasUsableWebGPUAdapter()).toBe(false);
	});

	it("caches a usable adapter so later tier switches do not re-probe", async () => {
		const requestAdapter = vi.fn().mockResolvedValue({ info: "fake" });
		fakeGpu(requestAdapter);
		const { hasUsableWebGPUAdapter } = await loadProbe();

		expect(await hasUsableWebGPUAdapter()).toBe(true);
		expect(await hasUsableWebGPUAdapter()).toBe(true);
		expect(requestAdapter).toHaveBeenCalledTimes(1);
	});

	it("probes again after a failure instead of caching it", async () => {
		const requestAdapter = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ info: "fake" });
		fakeGpu(requestAdapter);
		const { hasUsableWebGPUAdapter } = await loadProbe();

		expect(await hasUsableWebGPUAdapter()).toBe(false);
		expect(await hasUsableWebGPUAdapter()).toBe(true);
	});
});
