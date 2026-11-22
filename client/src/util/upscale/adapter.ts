// Which GPU the browser is actually rendering the enhancement on.
//
// On a hybrid laptop the GPU process runs on one adapter — whichever the OS hands it — and a
// page cannot choose another: `powerPreference: "high-performance"` does not move a WebGL or
// WebGPU context to the discrete card on Windows (see the note in cas.ts, and the measured
// `requestAdapter` results in docs/video-enhancement.zh-CN.md). The cost difference is not
// subtle: on the same machine the S chain measured 26–84 ms/frame on an Intel UHD 780 and
// 1–6 ms on the RTX 4060; the HQ chain 916 ms against 225 ms at 4K.
//
// Nobody is stopped from picking a heavy tier — hiding tiers is what broke the menu in v1.2.x.
// This only lets the settings panel say which adapter is in use before a viewer wonders why the
// picture crawls, and lets the degrade notice name the cause.

export type AdapterClass = "discrete" | "integrated" | "unknown";

export interface AdapterInfo {
	class: AdapterClass;
	/** The renderer string as reported, e.g. `ANGLE (NVIDIA, …)`. Null when unreadable. */
	renderer: string | null;
}

/** Software rasterizers are the weakest case of all, and behave like an integrated GPU here. */
const SOFTWARE_RASTERIZER = /swiftshader|llvmpipe|microsoft basic render/;
const NVIDIA = /nvidia|geforce|quadro|rtx|gtx/;
const INTEL = /intel/;
/** "Intel(R) Arc(TM) A770" is a discrete card; UHD / HD / Iris are the integrated ones. */
const INTEL_DISCRETE = /arc/;
const AMD = /amd|radeon|ati\b/;
const AMD_DISCRETE = /radeon\s*(rx|pro)\b/;
/** The Ryzen iGPUs are named by model number, not by the word "graphics". */
const AMD_INTEGRATED = /vega|\b\d{3}m\b|radeon\(tm\) graph|graphics/;
const APPLE_OR_MOBILE = /apple|mali|adreno/;
/** Where the model name ends in an ANGLE renderer string. */
const MODEL_END = /\(0x[0-9a-f]+\)|,?\s*or similar|direct3d|vs_\d|ps_\d|opengl|metal/i;

/**
 * Reads the class out of a WebGL renderer string. Vendor tokens survive Firefox's masked
 * renderer (`ANGLE (NVIDIA, NVIDIA GeForce GTX 980 …), or similar`), so the vendor is what the
 * decision hangs on, with the model names only separating Intel's and AMD's two ranges.
 */
export function classifyRenderer(renderer: string | null | undefined): AdapterClass {
	if (!renderer) {
		return "unknown";
	}
	const name = renderer.toLowerCase();
	if (SOFTWARE_RASTERIZER.test(name)) {
		return "integrated";
	}
	if (NVIDIA.test(name)) {
		return "discrete";
	}
	if (INTEL.test(name)) {
		return INTEL_DISCRETE.test(name) ? "discrete" : "integrated";
	}
	if (AMD.test(name)) {
		if (AMD_DISCRETE.test(name)) {
			return "discrete";
		}
		return AMD_INTEGRATED.test(name) ? "integrated" : "unknown";
	}
	if (APPLE_OR_MOBILE.test(name)) {
		return "integrated";
	}
	return "unknown";
}

/**
 * A short human name for the renderer: `Intel(R) UHD Graphics` out of the ANGLE string, which
 * also carries the adapter LUID, the D3D feature level and the driver's own version tokens.
 */
export function shortRendererName(renderer: string | null | undefined): string | null {
	if (!renderer) {
		return null;
	}
	const comma = renderer.indexOf(",");
	const rest = comma >= 0 ? renderer.slice(comma + 1) : renderer;
	const cut = rest.search(MODEL_END);
	const name = (cut >= 0 ? rest.slice(0, cut) : rest).replace(/\s+/g, " ").trim();
	return name || null;
}

/** Reads the renderer string from a throwaway WebGL2 context, then hands the context back. */
function readRenderer(): string | null {
	if (typeof document === "undefined") {
		return null;
	}
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2");
		if (!gl) {
			return null;
		}
		const info = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer = info
			? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string | null)
			: (gl.getParameter(gl.RENDERER) as string | null);
		// The page may already hold contexts for the enhancement, and browsers cap how many a
		// page can keep alive; this probe has no other use for its context.
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return typeof renderer === "string" && renderer.length > 0 ? renderer : null;
	} catch {
		return null;
	}
}

let cached: AdapterInfo | undefined;

/**
 * The adapter behind the picture, probed once per page. The browser's GPU process does not
 * change adapter while a page lives, so a settings panel, the details panel and a degrade
 * notice can all read the same answer.
 */
export function probeAdapter(): AdapterInfo {
	if (!cached) {
		const renderer = readRenderer();
		cached = { class: classifyRenderer(renderer), renderer };
	}
	return cached;
}
