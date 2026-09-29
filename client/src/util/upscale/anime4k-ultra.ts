// The heavy end of the Anime4K ladder for devices without WebGPU: mpv's "Mode A+A (HQ)" chain,
// the same shader list — and the same models — the WebGPU "quality" tier runs through
// anime4k-webgpu. Keeping it in its own module means the 400 KB of weights only download when a
// viewer picks this tier.
import { startAnime4KWebGLRenderer, type Anime4KChain } from "./anime4k-webgl";
import { ANIME4K_PASSES, ANIME4K_SEGMENTS } from "./anime4k-ultra-glsl";

export const ANIME4K_ULTRA_CHAIN: Anime4KChain = {
	label: "HQ",
	segments: ANIME4K_SEGMENTS.map(range => range.map(index => ANIME4K_PASSES[index])),
};

/** Every shader of the heavy chain, for the guard test. */
export const ANIME4K_ULTRA_SHADERS: string[] = ANIME4K_PASSES.map(pass => pass.fragment);

export function startAnime4KUltraRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
): ReturnType<typeof startAnime4KWebGLRenderer> {
	return startAnime4KWebGLRenderer(video, canvas, ANIME4K_ULTRA_CHAIN);
}
