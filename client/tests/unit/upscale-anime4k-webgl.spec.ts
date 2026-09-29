import { describe, expect, it } from "vitest";
import {
	ANIME4K_PASSES,
	ANIME4K_SEGMENTS,
	type Anime4KPassSpec,
} from "@/util/upscale/anime4k-glsl";
import { ANIME4K_ULTRA_CHAIN } from "@/util/upscale/anime4k-ultra";
import {
	ANIME4K_S_CHAIN,
	ANIME4K_UPSCALE_THRESHOLD,
	type Anime4KChain,
	planChain,
} from "@/util/upscale/anime4k-webgl";

const VIDEO = { width: 1920, height: 1080 };
const TWO_X = { width: 3840, height: 2160 };

const step = (over: Partial<Anime4KPassSpec>): Anime4KPassSpec => ({
	name: "x",
	desc: "x",
	video: false,
	reads: ["input"],
	scale: 1,
	pingPong: false,
	upscaleOnly: false,
	fragment: "",
	...over,
});

const chain = (segments: Anime4KPassSpec[][]): Anime4KChain => ({ label: "test", segments });

describe("Anime4K WebGL2 chain", () => {
	it("runs the x2 stage only when the target magnifies", () => {
		const magnified = planChain(ANIME4K_S_CHAIN, VIDEO, TWO_X).filter(step => step.active);
		expect(magnified).toHaveLength(9);
		expect(magnified.at(-1)?.pass.desc).toContain("Depth-to-Space");

		// Anime4K's own rule: the upscale shaders carry `//!WHEN OUTPUT.w MAIN.w / 1.200 >`.
		const plain = planChain(ANIME4K_S_CHAIN, VIDEO, VIDEO).filter(step => step.active);
		expect(plain).toHaveLength(4);
		expect(plain.some(step => step.pass.desc.includes("Depth-to-Space"))).toBe(false);
	});

	it("uses Anime4K's own 1.2x threshold for the upscale stages", () => {
		expect(ANIME4K_UPSCALE_THRESHOLD).toBe(1.2);
	});

	it("resolves input to whatever holds the picture at that point", () => {
		// Inside the restore stage MAIN is the video frame; the stage ends by adding its result to
		// it. The upscale stage then reads that picture — not the video — as its own MAIN.
		const steps = planChain(ANIME4K_S_CHAIN, VIDEO, TWO_X);
		const restoreLast = steps.find(step =>
			step.pass.desc.includes("Restore-CNN-(S)-Conv-3x3x3x8"),
		);
		expect(restoreLast?.reads).toEqual(["conv2d_2_tf", "video"]);
		const upscaleFirst = steps.find(step =>
			step.pass.desc.includes("Upscale-CNN-x2-(S)-Conv-4x3x3x3"),
		);
		expect(upscaleFirst?.reads).toEqual(["MAIN"]);
		expect(upscaleFirst?.source).toEqual(VIDEO);
	});

	it("keeps the generated S chain wired the way mpv runs it", () => {
		const [restore, upscale] = ANIME4K_SEGMENTS.map(range =>
			range.map(index => ANIME4K_PASSES[index]),
		);
		expect(restore[0]).toMatchObject({ video: true, reads: ["input"], scale: 1 });
		expect(restore.at(-1)).toMatchObject({ reads: ["conv2d_2_tf", "input"], scale: 1 });
		expect(upscale[0]).toMatchObject({ video: false, reads: ["input"], scale: 1 });
		expect(upscale.at(-1)).toMatchObject({
			reads: ["conv2d_last_tf", "input"],
			scale: 2,
			upscaleOnly: true,
		});
		expect(upscale.filter(pass => pass.scale === 2)).toHaveLength(1);
	});

	it("keeps a buffer alive until the last pass that samples it", () => {
		// The VL chains write a pair of feature-map halves per layer and the next layer reads both,
		// so alternating two buffers would overwrite a texture that is still an input.
		const steps = planChain(
			chain([
				[
					step({ name: "a", reads: ["input"] }),
					step({ name: "a1", reads: ["input"] }),
					step({ name: "b", reads: ["a", "a1"] }),
					step({ name: "b1", reads: ["a", "a1"] }),
					step({ name: "MAIN", reads: ["b", "b1", "input"] }),
				],
			]),
			VIDEO,
			VIDEO,
		);
		expect(steps.map(step => step.slot)).toEqual([0, 1, 2, 3, 0]);
	});

	it("never renders into the buffer the picture lives in", () => {
		// A pass that adds the picture back — the depth-to-space ones do — must still find it, so
		// its buffer stays off limits for everything that runs in between.
		const steps = planChain(
			chain([
				[
					step({ name: "MAIN", reads: ["input"] }),
					step({ name: "a", reads: ["input"] }),
					step({ name: "b", reads: ["a", "input"] }),
					step({ name: "MAIN", reads: ["b", "input"], scale: 2 }),
				],
			]),
			VIDEO,
			TWO_X,
		);
		expect(steps.map(step => step.slot)).toEqual([0, 1, 2, 1]);
		// The picture the last pass adds comes from the first pass's buffer, not from "b".
		expect(steps[3].reads).toEqual(["b", "MAIN"]);
		expect(steps[3].source).toEqual(VIDEO);
	});

	it("gives a read-and-write pass a buffer of its own", () => {
		// Clamp_Highlights' second statistics pass binds STATSMAX and saves STATSMAX; a texture
		// cannot be sampled and rendered into at the same time.
		const steps = planChain(
			chain([
				[
					step({ name: "stat", reads: ["input"] }),
					step({ name: "stat", reads: ["stat"], pingPong: true }),
					step({ name: "MAIN", reads: ["stat", "input"] }),
				],
			]),
			VIDEO,
			VIDEO,
		);
		expect(steps.map(step => step.slot)).toEqual([0, 1, 0]);
	});

	it("never renders into a buffer something still samples", () => {
		// Every read is resolved to the write it observes, and every render is checked against the
		// last reader of the buffer it lands in. This is the invariant the buffer plan exists for:
		// reuse a buffer too early and a later pass samples the wrong picture.
		for (const which of [ANIME4K_S_CHAIN, ANIME4K_ULTRA_CHAIN]) {
			for (const target of [VIDEO, TWO_X]) {
				const steps = planChain(which, VIDEO, target);
				const writer = new Map<string, number>();
				const neededUntil = new Map<number, number>();
				steps.forEach((step, position) => {
					if (!step.active) {
						return;
					}
					for (const name of step.reads) {
						const written = writer.get(name) ?? -1;
						neededUntil.set(written, position);
					}
					writer.set(step.pass.name, position);
				});
				const holder = new Map<number, number>();
				steps.forEach((step, position) => {
					if (!step.active) {
						return;
					}
					const previous = holder.get(step.slot);
					if (previous !== undefined) {
						expect(neededUntil.get(previous) ?? -1).toBeLessThan(position);
					}
					holder.set(step.slot, position);
				});
			}
		}
	});

	it("hands a buffer back once its last pass has run", () => {
		const steps = planChain(ANIME4K_S_CHAIN, VIDEO, TWO_X);
		// The picture the present pass draws is the one buffer that has to survive the last pass.
		expect(steps.at(-1)?.releases).not.toContain(steps.at(-1)?.slot);
		expect(steps.some(step => step.releases.length > 0)).toBe(true);

		const ultra = planChain(ANIME4K_ULTRA_CHAIN, VIDEO, TWO_X);
		// Clamp_Highlights' statistics are read by the clamp at the very end, so their buffer may
		// only be handed back after it — nothing along the way may free it. The second statistics
		// pass is the one that moves the name to the buffer the clamp reads.
		const statsSlot = ultra.filter(step => step.pass.name === "STATSMAX").at(-1)?.slot;
		expect(ultra.at(-1)?.reads).toContain("STATSMAX");
		expect(ultra.slice(0, -1).some(step => step.releases.includes(statsSlot as number))).toBe(
			false,
		);
	});

	it("keeps the heavy chain in its own module, with the clamp last", () => {
		expect(ANIME4K_ULTRA_CHAIN.label).toBe("HQ");
		expect(ANIME4K_ULTRA_CHAIN.segments.map(segment => segment.length)).toEqual([
			2, 17, 18, 8, 9, 1,
		]);
		const steps = planChain(ANIME4K_ULTRA_CHAIN, VIDEO, TWO_X);
		// mpv runs Clamp_Highlights' statistics first and its clamp at PREKERNEL, after every MAIN
		// pass, so the last thing the chain does is clamp the finished picture.
		expect(steps[0].pass.desc).toContain("Compute-Statistics");
		const last = steps.at(-1);
		expect(last?.pass.desc).toContain("De-Ring-Clamp");
		expect(last?.reads).toEqual(["STATSMAX", "MAIN"]);
		expect(last?.width).toBe(3840);
		// At a 2x target the second x2 stage is 1:1 with the target and skips itself, exactly as it
		// does in mpv: 46 passes run, not 55.
		expect(steps.filter(step => step.active)).toHaveLength(46);
	});
});
