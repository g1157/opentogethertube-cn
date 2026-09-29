import { describe, expect, it } from "vitest";
import { ANIME4K_RESTORE_PASSES, ANIME4K_UPSCALE_PASSES } from "@/util/upscale/anime4k-glsl";
import { ANIME4K_UPSCALE_THRESHOLD, planAnime4KWebGLPasses } from "@/util/upscale/anime4k-webgl";

describe("Anime4K WebGL2 chain", () => {
	it("restores and then upscales when the target magnifies", () => {
		const passes = planAnime4KWebGLPasses({ magnifying: true });
		expect(passes).toHaveLength(ANIME4K_RESTORE_PASSES.length + ANIME4K_UPSCALE_PASSES.length);
		expect(passes).toHaveLength(9);
		expect(passes[passes.length - 1]).toContain("Depth-to-Space");
	});

	it("keeps the restoration when the target is not large enough for the x2 stage", () => {
		// Anime4K's own rule: the upscale shaders carry `//!WHEN OUTPUT.w MAIN.w / 1.200 >`.
		const passes = planAnime4KWebGLPasses({ magnifying: false });
		expect(passes).toHaveLength(ANIME4K_RESTORE_PASSES.length);
		expect(passes.some(desc => desc.includes("Depth-to-Space"))).toBe(false);
	});

	it("keeps the generated chain wired the way mpv runs it", () => {
		// Inside the restore shader MAIN is the video frame; inside the upscale shader it is the
		// picture the restore chain produced. Both chains end by adding their result to it, and
		// only the depth-to-space pass carries the x2 upscale.
		expect(ANIME4K_RESTORE_PASSES[0]).toMatchObject({ video: true, base: false, scale: 1 });
		expect(ANIME4K_RESTORE_PASSES.at(-1)).toMatchObject({
			base: true,
			baseVideo: true,
			scale: 1,
		});
		expect(ANIME4K_UPSCALE_PASSES[0]).toMatchObject({ video: false, base: false, scale: 1 });
		expect(ANIME4K_UPSCALE_PASSES.at(-1)).toMatchObject({
			base: true,
			baseVideo: false,
			scale: 2,
		});
		expect(ANIME4K_UPSCALE_PASSES.filter(pass => pass.scale === 2)).toHaveLength(1);
	});

	it("uses Anime4K's own 1.2x threshold for the upscale stages", () => {
		expect(ANIME4K_UPSCALE_THRESHOLD).toBe(1.2);
	});
});
