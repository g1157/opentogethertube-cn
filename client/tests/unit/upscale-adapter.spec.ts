import { describe, expect, it } from "vitest";
import { classifyRenderer, shortRendererName } from "@/util/upscale/adapter";

describe("graphics adapter classification", () => {
	it("takes the discrete card on the strings a hybrid laptop actually reports", () => {
		expect(
			classifyRenderer(
				"ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
			),
		).toBe("discrete");
		expect(classifyRenderer("ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics, OpenGL 4.5)")).toBe(
			"discrete",
		);
		expect(
			classifyRenderer("ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0)"),
		).toBe("discrete");
	});

	it("takes the integrated one, which is the case the settings panel warns about", () => {
		expect(
			classifyRenderer(
				"ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0)",
			),
		).toBe("integrated");
		expect(classifyRenderer("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)")).toBe(
			"integrated",
		);
		expect(
			classifyRenderer("ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)"),
		).toBe("integrated");
		// The Ryzen iGPUs are named by model number, not by the word "graphics".
		expect(classifyRenderer("ANGLE (AMD, AMD Radeon 780M Direct3D11 vs_5_0 ps_5_0)")).toBe(
			"integrated",
		);
		expect(classifyRenderer("Apple M2 Pro, or similar")).toBe("integrated");
	});

	it("reads through the renderer Firefox masks", () => {
		// Firefox replaces the model with a canned one and appends "or similar"; the vendor
		// token it keeps is what the decision hangs on.
		expect(
			classifyRenderer(
				"ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar",
			),
		).toBe("discrete");
		expect(
			classifyRenderer(
				"ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar",
			),
		).toBe("integrated");
	});

	it("treats a software rasterizer as the weakest case, and an unknown string as unknown", () => {
		expect(
			classifyRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))"),
		).toBe("integrated");
		expect(classifyRenderer("Mesa/X.org llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("integrated");
		expect(classifyRenderer(null)).toBe("unknown");
		expect(classifyRenderer("")).toBe("unknown");
		expect(classifyRenderer("Some Vendor Something")).toBe("unknown");
	});
});

describe("adapter name", () => {
	it("keeps the model and drops the driver tokens", () => {
		expect(
			shortRendererName(
				"ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
			),
		).toBe("NVIDIA GeForce RTX 4060 Laptop GPU");
		// "Intel(R)" has a parenthesis of its own; the model id is what ends the name.
		expect(
			shortRendererName(
				"ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0)",
			),
		).toBe("Intel(R) UHD Graphics");
		expect(
			shortRendererName(
				"ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar",
			),
		).toBe("NVIDIA GeForce GTX 980");
	});

	it("returns null when there is nothing to show", () => {
		expect(shortRendererName(null)).toBeNull();
		expect(shortRendererName("")).toBeNull();
	});
});
