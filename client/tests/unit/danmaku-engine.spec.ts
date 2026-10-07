import { describe, expect, it } from "vitest";
import {
	DanmakuEngine,
	FIXED_DURATION,
	type DanmakuEngineConfig,
	type DanmakuRenderItem,
} from "@/util/danmaku/engine";
import type { DanmakuItem } from "@/util/danmaku/parse";

const TEXT_WIDTH_RATIO = 0.6;
const measure = (text: string, fontPx: number) => text.length * fontPx * TEXT_WIDTH_RATIO;

function makeConfig(partial: Partial<DanmakuEngineConfig> = {}): DanmakuEngineConfig {
	return {
		width: 1280,
		height: 720,
		fontPx: 20,
		scrollDuration: 8,
		speed: 1,
		antiCollision: true,
		maxOnScreen: 100,
		blockScroll: false,
		blockTop: false,
		blockBottom: false,
		blockColored: false,
		area: "full",
		maxPerSecond: Number.POSITIVE_INFINITY,
		...partial,
	};
}

function makeItem(partial: Partial<DanmakuItem> = {}): DanmakuItem {
	return { time: 0, mode: "scroll", color: "#ffffff", text: "测试", ...partial };
}

/** Ticks in small steps; a single jump larger than a second is treated as a seek. */
function advance(engine: DanmakuEngine, from: number, to: number, step = 0.5) {
	let last: DanmakuRenderItem[] = [];
	for (let t = from; t <= to + 1e-9; t += step) {
		last = engine.tick(t);
	}
	return last;
}

describe("DanmakuEngine scheduling", () => {
	it("keeps the comments inside the selected half of the picture", () => {
		const bottom = new DanmakuEngine(makeConfig({ area: "bottom" }), measure);
		bottom.setItems([makeItem({ time: 0, text: "下半屏" })]);
		const [lowered] = bottom.tick(0);
		expect(lowered.y).toBeGreaterThanOrEqual(360);

		const top = new DanmakuEngine(makeConfig({ area: "top" }), measure);
		top.setItems([makeItem({ time: 0, text: "上半屏" })]);
		const [raised] = top.tick(0);
		expect(raised.y).toBeLessThanOrEqual(360);

		// A fixed comment anchors to its own half too.
		const topFixed = new DanmakuEngine(makeConfig({ area: "top" }), measure);
		topFixed.setItems([makeItem({ time: 0, text: "顶部固定", mode: "top" })]);
		const [fixed] = topFixed.tick(0);
		expect(fixed.y).toBeLessThanOrEqual(360);
	});

	it("thins a burst to the density limit and leaves a calm track untouched", () => {
		const items = Array.from({ length: 6 }, (_, i) =>
			makeItem({ time: i * 0.05, text: `第${i}条` }),
		);
		const sparse = new DanmakuEngine(
			makeConfig({ antiCollision: false, maxPerSecond: 2 }),
			measure,
		);
		sparse.setItems(items);
		expect(sparse.tick(0)).toHaveLength(1);
		// Five more comments arrive inside the same second; the second one is the last the
		// density limit lets through.
		expect(sparse.tick(0.3)).toHaveLength(2);

		const unlimited = new DanmakuEngine(makeConfig({ antiCollision: false }), measure);
		unlimited.setItems(items);
		expect(unlimited.tick(0)).toHaveLength(1);
		expect(unlimited.tick(0.3)).toHaveLength(6);
	});

	it("spawns scroll comments at their media time and moves them left", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([makeItem({ time: 1, text: "第一条" })]);
		expect(engine.tick(0.5)).toHaveLength(0);
		const [spawned] = engine.tick(1);
		expect(spawned.x).toBeCloseTo(1280, 5);
		const [moved] = engine.tick(1.5);
		expect(moved.x).toBeCloseTo(1280 - (1280 + measure("第一条", 20)) / 8 / 2, 1);
	});

	it("keeps every scroll comment on screen for exactly the traverse time", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([makeItem({ time: 0, text: "过场" })]);
		engine.tick(0);
		expect(advance(engine, 0.5, 7.5)).toHaveLength(1);
		expect(advance(engine, 7.6, 8.1, 0.25)).toHaveLength(0);
	});

	it("scales the traverse time with the speed setting", () => {
		const engine = new DanmakuEngine(makeConfig({ speed: 2 }), measure);
		engine.setItems([makeItem({ time: 0, text: "加速" })]);
		engine.tick(0);
		expect(advance(engine, 0.5, 3.5)).toHaveLength(1);
		expect(advance(engine, 3.6, 4.05, 0.15)).toHaveLength(0);
	});

	it("drops on-screen comments and re-anchors when media time jumps", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([
			makeItem({ time: 0, text: "0 秒" }),
			makeItem({ time: 100, text: "100 秒" }),
		]);
		engine.tick(0);
		expect(engine.tick(0.5)).toHaveLength(1);
		const afterSeek = engine.tick(100);
		expect(afterSeek.some(item => item.text === "0 秒")).toBe(false);
		expect(afterSeek.some(item => item.text === "100 秒")).toBe(true);
	});

	it("holds the clock through small backward steps but rewinds on a real seek", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([
			makeItem({ time: 0, text: "现在" }),
			makeItem({ time: 50, text: "后面" }),
		]);
		expect(engine.tick(0)).toHaveLength(1);
		expect(engine.tick(0.8)).toHaveLength(1);
		expect(engine.tick(1.6)).toHaveLength(1);
		expect(engine.tick(2.4)).toHaveLength(1);
		expect(engine.tick(3.2)).toHaveLength(1);
		expect(engine.tick(4)).toHaveLength(1);
		// The layer extrapolates its clock ahead of video.currentTime, so a pause or a
		// repaint takes a small step back; the frame must not be wiped for that.
		expect(engine.tick(3.8)).toHaveLength(1);
		expect(engine.tick(4.2)).toHaveLength(1);
		// A real rewind is still a seek: the screen clears and the schedule re-anchors.
		expect(engine.tick(1)).toHaveLength(0);
		expect(engine.tick(49.9)).toHaveLength(0);
		expect(engine.tick(50.1)).toHaveLength(1);
	});

	it("holds fixed comments centered in a slot for their full duration", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([makeItem({ time: 0, mode: "top", text: "顶部" })]);
		engine.tick(0);
		const [rendered] = engine.tick(1);
		expect(rendered.x).toBeCloseTo((1280 - measure("顶部", 20)) / 2, 5);
		expect(rendered.y).toBeGreaterThan(0);
		expect(advance(engine, 1.5, 4.5)).toHaveLength(1);
		expect(advance(engine, 4.6, 5.5, 0.3)).toHaveLength(0);
	});

	it("never lets two comments in one lane overlap", () => {
		const config = makeConfig();
		const engine = new DanmakuEngine(config, measure);
		engine.setItems(
			Array.from({ length: 60 }, (_, index) =>
				makeItem({ time: index * 0.15, text: `第 ${index} 条评论内容` }),
			),
		);
		for (let t = 0; t <= 12; t += 1 / 30) {
			const rendered = engine.tick(t);
			const lanes = new Map<number, { x: number; w: number }[]>();
			for (const item of rendered) {
				const occupants = lanes.get(item.y) ?? [];
				occupants.push({ x: item.x, w: measure(item.text, config.fontPx) });
				lanes.set(item.y, occupants);
			}
			for (const occupants of lanes.values()) {
				for (let i = 0; i < occupants.length; i++) {
					for (let j = i + 1; j < occupants.length; j++) {
						const a = occupants[i];
						const b = occupants[j];
						expect(
							a.x + a.w <= b.x + 0.001 || b.x + b.w <= a.x + 0.001,
							`t=${t}: ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("drops a comment when every lane is taken, unless anti-collision is off", () => {
		// One lane only: height barely covers two lane pitches.
		const singleLane = makeConfig({ height: 44 });
		const strict = new DanmakuEngine(singleLane, measure);
		strict.setItems([
			makeItem({ time: 0, text: "很长的一条评论内容" }),
			makeItem({ time: 0.1, text: "很长的一条评论内容" }),
		]);
		strict.tick(0);
		expect(strict.tick(0.1)).toHaveLength(1);

		const loose = new DanmakuEngine({ ...singleLane, antiCollision: false }, measure);
		loose.setItems([
			makeItem({ time: 0, text: "很长的一条评论内容" }),
			makeItem({ time: 0.1, text: "很长的一条评论内容" }),
		]);
		loose.tick(0);
		// Both share the only lane and overlap, which the loose mode accepts.
		expect(loose.tick(0.1)).toHaveLength(2);
	});

	it("caps how many comments are on screen at once", () => {
		const engine = new DanmakuEngine(makeConfig({ maxOnScreen: 3 }), measure);
		engine.setItems(
			Array.from({ length: 10 }, (_, index) => makeItem({ time: 0, text: `评论 ${index}` })),
		);
		expect(engine.tick(0)).toHaveLength(3);
	});

	it("skips blocked kinds and colored comments", () => {
		const engine = new DanmakuEngine(
			makeConfig({ blockScroll: true, blockColored: true }),
			measure,
		);
		engine.setItems([
			makeItem({ time: 0, mode: "scroll", text: "滚动" }),
			makeItem({ time: 0, mode: "top", text: "顶部" }),
			makeItem({ time: 0, mode: "top", text: "红色", color: "#ff0000" }),
			makeItem({ time: 0, mode: "bottom", text: "底部" }),
		]);
		const rendered = engine.tick(0);
		expect(rendered.map(item => item.text).sort()).toEqual(["底部", "顶部"]);
	});

	it("re-lanes the active comments instead of dropping them when the box changes", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([makeItem({ time: 0, text: "像素" })]);
		const [before] = engine.tick(0);
		expect(before.x).toBeCloseTo(1280, 5);
		// A fullscreen toggle or a resize must keep the comments flying, re-anchored to
		// the new picture box.
		engine.configure({ width: 640, height: 360 });
		const [after] = engine.tick(0.1);
		expect(after).toBeDefined();
		expect(after.x).toBeLessThanOrEqual(640);
		expect(after.y).toBeLessThanOrEqual(360);
	});

	it("keeps the active comments when a configure call changes nothing geometric", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([makeItem({ time: 0, text: "像素" })]);
		engine.tick(0);
		// The layer replays its whole config on every viewport event; identical values
		// must not blank the screen.
		engine.configure(makeConfig());
		expect(engine.tick(0.1)).toHaveLength(1);
	});

	it("swaps the track under a running comment when the offset changes", () => {
		const engine = new DanmakuEngine(makeConfig(), measure);
		engine.setItems([makeItem({ time: 0, text: "旧轨" })]);
		expect(engine.tick(0)).toHaveLength(1);
		expect(engine.tick(1)).toHaveLength(1);
		// The same track, shifted later: the running comment keeps flying...
		engine.replaceItems([
			makeItem({ time: 0.5, text: "旧轨" }),
			makeItem({ time: 3, text: "未来" }),
		]);
		expect(engine.tick(1.2)).toHaveLength(1);
		expect(engine.tick(2.1)).toHaveLength(1);
		// ...and the shifted schedule spawns from its new times (the one now in the past
		// is not replayed).
		expect(engine.tick(3.05)).toHaveLength(2);
		expect(engine.activeCount).toBe(2);
	});
});
