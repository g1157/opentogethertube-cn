import { describe, expect, it } from "vitest";
import {
	ANIME4K_PASSES,
	ANIME4K_SEGMENTS,
	type Anime4KPassSpec,
} from "@/util/upscale/anime4k-glsl";
import { ANIME4K_ULTRA_CHAIN } from "@/util/upscale/anime4k-ultra";
import {
	ANIME4K_UPSCALE_THRESHOLD,
	planAnime4KWebGLPasses,
	planSegmentBuffers,
} from "@/util/upscale/anime4k-webgl";

const passthrough = (over: Partial<Anime4KPassSpec>): Anime4KPassSpec => ({
	name: "x",
	desc: "x",
	video: false,
	base: false,
	baseName: "input",
	baseVideo: false,
	scale: 1,
	pingPong: false,
	upscaleOnly: false,
	fragment: "",
	...over,
});

describe("Anime4K WebGL2 chain", () => {
	it("restores and then upscales when the target magnifies", () => {
		const passes = planAnime4KWebGLPasses({ magnifying: true });
		expect(passes).toHaveLength(9);
		expect(passes[passes.length - 1]).toContain("Depth-to-Space");
	});

	it("keeps the restoration when the target is not large enough for the x2 stage", () => {
		// Anime4K's own rule: the upscale shaders carry `//!WHEN OUTPUT.w MAIN.w / 1.200 >`.
		const passes = planAnime4KWebGLPasses({ magnifying: false });
		expect(passes).toHaveLength(4);
		expect(passes.some(desc => desc.includes("Depth-to-Space"))).toBe(false);
	});

	it("keeps the generated S chain wired the way mpv runs it", () => {
		// Inside the restore segment MAIN is the video frame; inside the upscale segment it is the
		// picture the restore segment produced. Both end by adding their result to it, and only the
		// depth-to-space pass carries the x2 upscale.
		const [restore, upscale] = ANIME4K_SEGMENTS.map(range =>
			range.map(index => ANIME4K_PASSES[index]),
		);
		expect(restore[0]).toMatchObject({ video: true, base: false, scale: 1 });
		expect(restore.at(-1)).toMatchObject({
			base: true,
			baseName: "input",
			baseVideo: true,
			scale: 1,
		});
		expect(upscale[0]).toMatchObject({ video: false, base: false, scale: 1 });
		expect(upscale.at(-1)).toMatchObject({
			base: true,
			baseVideo: false,
			scale: 2,
			upscaleOnly: true,
		});
		expect(upscale.filter(pass => pass.scale === 2)).toHaveLength(1);
	});

	it("uses Anime4K's own 1.2x threshold for the upscale stages", () => {
		expect(ANIME4K_UPSCALE_THRESHOLD).toBe(1.2);
	});

	it("alternates a segment's two buffers and gives a read-and-write pass one of its own", () => {
		const segment = [
			passthrough({ name: "a" }),
			passthrough({ name: "b" }),
			passthrough({ name: "b", pingPong: true }),
			passthrough({ name: "c" }),
		];
		// The third pass cannot sample and render into the same texture, so it gets its own slot;
		// the fourth writes the now-free buffer of the second.
		expect(planSegmentBuffers(segment)).toEqual([0, 1, 2, 1]);
	});

	it("keeps the heavy chain in its own module", () => {
		expect(ANIME4K_ULTRA_CHAIN.label).toBe("HQ");
		expect(ANIME4K_ULTRA_CHAIN.segments.flat()).toHaveLength(52);
		expect(ANIME4K_ULTRA_CHAIN.segments.map(segment => segment.length)).toEqual([17, 18, 8, 9]);
	});
});
