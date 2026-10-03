import type { DanmakuArea } from "@/stores/settings";
import type { DanmakuItem } from "./parse";

/** One on-screen comment, in CSS pixels relative to the video content box. */
export interface DanmakuRenderItem {
	text: string;
	color: string;
	x: number;
	y: number;
}

export interface DanmakuEngineConfig {
	/** Video content box size in CSS pixels (letterbox bars excluded). */
	width: number;
	height: number;
	/** Destination font size in CSS pixels; lane geometry is derived from it. */
	fontPx: number;
	/** Seconds for a comment to cross the full width at speed 1. */
	scrollDuration: number;
	/** User speed multiplier; higher moves comments faster. */
	speed: number;
	antiCollision: boolean;
	maxOnScreen: number;
	blockScroll: boolean;
	blockTop: boolean;
	blockBottom: boolean;
	blockColored: boolean;
	/** Which part of the picture the comments may use: the whole box, or one half. */
	area: DanmakuArea;
	/**
	 * Comments accepted per second; the excess is dropped like a busy lane's. Infinity
	 * keeps every comment the lanes can hold.
	 */
	maxPerSecond: number;
}

/** Vertical band of the picture each area uses, as [from, to] fractions of its height. */
const AREA_BANDS: Record<DanmakuArea, readonly [number, number]> = {
	full: [0, 1],
	top: [0, 0.5],
	bottom: [0.5, 1],
};

/** Fixed (top/bottom) comments hold their slot for this long, like the upstream player. */
export const FIXED_DURATION = 5;

/** Lane pitch as a multiple of the font size, from girigiri's measured 21px lanes at 19.2px. */
const LANE_HEIGHT_RATIO = 1.1;
/** A time step beyond this is a seek or a source change, not playback. */
const SEEK_GAP_SECONDS = 1;

interface ScrollOccupant {
	startTime: number;
	textW: number;
	v: number;
}

interface ActiveItem {
	item: DanmakuItem;
	startTime: number;
	textW: number;
	/** Scroll velocity in px/s; 0 for fixed comments. */
	v: number;
	y: number;
	/** Fixed comments only: when their slot frees up. */
	expireAt: number;
}

/**
 * Schedules parsed comments into lanes and reports what should be on screen at a given
 * media time. Pure bookkeeping — text measuring is injected and drawing happens in the
 * layer, so the whole scheduler runs headless under test.
 */
export class DanmakuEngine {
	private items: DanmakuItem[] = [];
	private config: DanmakuEngineConfig;
	private measure: (text: string, fontPx: number) => number;
	private active: ActiveItem[] = [];
	private scheduleIndex = 0;
	private lastTime: number | null = null;
	private laneHeight = 1;
	/** Top edge and height of the band the lanes may use, in CSS pixels. */
	private bandTop = 0;
	private bandHeight = 0;
	private scrollLanes: (ScrollOccupant | null)[] = [];
	private topSlots: (number | null)[] = [];
	private bottomSlots: (number | null)[] = [];
	/** Media times of the comments accepted in the last second, for the density limit. */
	private spawnTimes: number[] = [];

	constructor(config: DanmakuEngineConfig, measure: (text: string, fontPx: number) => number) {
		this.config = { ...config };
		this.measure = measure;
		this.rebuildLanes();
	}

	setItems(items: DanmakuItem[]) {
		this.items = items;
		this.reset();
	}

	/** Geometry changes invalidate every stored position, so active comments are dropped. */
	configure(partial: Partial<DanmakuEngineConfig>) {
		this.config = { ...this.config, ...partial };
		if (
			partial.width !== undefined ||
			partial.height !== undefined ||
			partial.fontPx !== undefined ||
			partial.area !== undefined
		) {
			this.rebuildLanes();
			this.active = [];
		}
	}

	/** Returns what to draw at media time `now`, advancing the scheduler. */
	tick(now: number): DanmakuRenderItem[] {
		if (this.lastTime === null) {
			// First frame after a reset: everything before now is already past.
			this.scheduleIndex = lowerBound(this.items, now);
		} else if (now < this.lastTime || now - this.lastTime > SEEK_GAP_SECONDS) {
			this.seekTo(now);
		}
		this.spawn(now);
		this.lastTime = now;
		return this.render(now);
	}

	/** Drops everything on screen and re-anchors the schedule at media time `now`. */
	seekTo(now: number) {
		this.active = [];
		this.scrollLanes.fill(null);
		this.topSlots.fill(null);
		this.bottomSlots.fill(null);
		this.spawnTimes = [];
		this.scheduleIndex = lowerBound(this.items, now);
		this.lastTime = now;
	}

	reset() {
		this.seekTo(0);
		this.lastTime = null;
	}

	get activeCount(): number {
		return this.active.length;
	}

	private rebuildLanes() {
		const { height, fontPx, area } = this.config;
		this.laneHeight = Math.max(1, fontPx * LANE_HEIGHT_RATIO);
		const [from, to] = AREA_BANDS[area] ?? AREA_BANDS.full;
		this.bandTop = height * from;
		// At least one lane has to fit, or a half-height picture would show nothing.
		this.bandHeight = Math.max(this.laneHeight, height * (to - from));
		// The first lane sits one lane-height down, matching the upstream player's layout.
		const lanes = Math.max(1, Math.floor(this.bandHeight / this.laneHeight) - 1);
		this.scrollLanes = new Array(lanes).fill(null);
		this.topSlots = new Array(lanes).fill(null);
		this.bottomSlots = new Array(lanes).fill(null);
	}

	private spawn(now: number) {
		const {
			maxOnScreen,
			blockScroll,
			blockTop,
			blockBottom,
			blockColored,
			fontPx,
			width,
			maxPerSecond,
		} = this.config;
		// Density: only the comments accepted in the last second count against the limit, so
		// a burst thins out while a calm stretch is left untouched.
		while (this.spawnTimes.length > 0 && now - this.spawnTimes[0] >= 1) {
			this.spawnTimes.shift();
		}
		const withinDensity = () =>
			!Number.isFinite(maxPerSecond) || this.spawnTimes.length < maxPerSecond;
		while (this.scheduleIndex < this.items.length) {
			const item = this.items[this.scheduleIndex];
			if (item.time > now) {
				break;
			}
			this.scheduleIndex++;
			if (this.active.length >= maxOnScreen || !withinDensity()) {
				continue;
			}
			if (item.mode === "scroll" && blockScroll) {
				continue;
			}
			if (item.mode === "top" && blockTop) {
				continue;
			}
			if (item.mode === "bottom" && blockBottom) {
				continue;
			}
			if (blockColored && item.color.toLowerCase() !== "#ffffff") {
				continue;
			}
			const textW = this.measure(item.text, fontPx);
			if (item.mode === "scroll") {
				const duration = this.config.scrollDuration / Math.max(this.config.speed, 0.1);
				const v = (width + textW) / duration;
				const lane = this.findScrollLane(now, textW, v);
				// No lane has room: the comment is dropped, same as the upstream player.
				if (lane === null) {
					continue;
				}
				this.scrollLanes[lane] = { startTime: now, textW, v };
				this.active.push({
					item,
					startTime: now,
					textW,
					v,
					y: this.laneY(lane),
					expireAt: Number.POSITIVE_INFINITY,
				});
			} else {
				const slots = item.mode === "top" ? this.topSlots : this.bottomSlots;
				const index = slots.findIndex(expireAt => expireAt === null || expireAt <= now);
				if (index === -1) {
					continue;
				}
				slots[index] = now + FIXED_DURATION;
				this.active.push({
					item,
					startTime: now,
					textW,
					v: 0,
					y: this.slotY(item.mode, index),
					expireAt: now + FIXED_DURATION,
				});
			}
			this.spawnTimes.push(now);
		}
	}

	private findScrollLane(t: number, textW: number, v: number): number | null {
		let oldestLane: number | null = null;
		for (let i = 0; i < this.scrollLanes.length; i++) {
			const occupant = this.scrollLanes[i];
			if (!occupant) {
				return i;
			}
			if (!this.config.antiCollision) {
				const oldest = oldestLane === null ? null : this.scrollLanes[oldestLane];
				if (!oldest || occupant.startTime < oldest.startTime) {
					oldestLane = i;
				}
				continue;
			}
			const tail = this.config.width - occupant.v * (t - occupant.startTime) + occupant.textW;
			// The previous comment's trailing edge must sit far enough left that this one
			// cannot reach it before it leaves the screen. Derived from the closing speed:
			// tail <= width * vPrev / vNew.
			if (tail <= this.config.width * (occupant.v / v)) {
				return i;
			}
		}
		return this.config.antiCollision ? null : oldestLane;
	}

	private laneY(index: number): number {
		return this.bandTop + (index + 1) * this.laneHeight;
	}

	private slotY(mode: "top" | "bottom", index: number): number {
		const pitch = (index + 1) * this.laneHeight;
		return mode === "top" ? this.bandTop + pitch : this.bandTop + this.bandHeight - pitch;
	}

	private render(now: number): DanmakuRenderItem[] {
		const out: DanmakuRenderItem[] = [];
		for (let i = this.active.length - 1; i >= 0; i--) {
			const active = this.active[i];
			if (active.item.mode === "scroll") {
				const x = this.config.width - active.v * (now - active.startTime);
				if (x + active.textW <= 0) {
					this.active.splice(i, 1);
					continue;
				}
				out.push({ text: active.item.text, color: active.item.color, x, y: active.y });
			} else {
				if (active.expireAt <= now) {
					this.active.splice(i, 1);
					continue;
				}
				out.push({
					text: active.item.text,
					color: active.item.color,
					x: (this.config.width - active.textW) / 2,
					y: active.y,
				});
			}
		}
		return out;
	}
}

function lowerBound(items: DanmakuItem[], time: number): number {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (items[mid].time < time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}
