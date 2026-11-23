import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateCurrentPosition } from "ott-common/timestamp";
import type { ServerMessageSync } from "ott-common/models/messages";
import { buildNewStore } from "@/store";
import { attachServerClock } from "@/stores/room";
import {
	getServerClockOffsetMs,
	noteLatencySample,
	resetLatencySamples,
} from "@/util/connection-latency";

describe("room store clock anchor", () => {
	const video = { service: "youtube", id: "video1" };

	beforeEach(() => {
		// The monotonic clock moves with the wall clock here. With only `Date` faked, every
		// advance looks like a system clock step and the measured offset is (rightly) dropped.
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
				"performance",
			],
		});
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		resetLatencySamples();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetLatencySamples();
	});

	/** What the room view shows as the room's current position. */
	function roomPosition(store: ReturnType<typeof buildNewStore>): number {
		const room = store.state.room;
		return room.isPlaying
			? calculateCurrentPosition(
					room.playbackStartTime,
					new Date(),
					room.playbackPosition,
					room.playbackSpeed,
				)
			: room.playbackPosition;
	}

	async function playFrom(store: ReturnType<typeof buildNewStore>, position: number) {
		await store.dispatch("room/sync", {
			action: "sync",
			currentSource: video,
			isPlaying: true,
			playbackPosition: position,
		} as ServerMessageSync);
	}

	it("keeps the clock when a metadata-only currentSource arrives", async () => {
		const store = buildNewStore();
		await playFrom(store, 100);
		vi.advanceTimersByTime(600_000);
		expect(roomPosition(store)).toBeCloseTo(700, 0);

		// The server publishes a subtitle change for the same video without a position; the
		// client used to re-anchor its clock around the old position and jump back to 100.
		await store.dispatch("room/sync", {
			action: "sync",
			currentSource: { ...video, subtitleUrl: "https://example.com/subs.vtt" },
		} as ServerMessageSync);

		expect(roomPosition(store)).toBeCloseTo(700, 0);
	});

	it("re-anchors when the message actually switches to another video", async () => {
		const store = buildNewStore();
		await playFrom(store, 100);
		vi.advanceTimersByTime(600_000);

		await store.dispatch("room/sync", {
			action: "sync",
			currentSource: { service: "youtube", id: "video2" },
		} as ServerMessageSync);

		// The old video's position cannot describe the new one; the clock restarts at it.
		expect(roomPosition(store)).toBeCloseTo(100, 0);
	});

	describe("with a measured clock offset", () => {
		/** A server whose clock is `skewMs` ahead of ours, measured with a clean round trip. */
		function measureClock(skewMs: number, at = Date.now()) {
			noteLatencySample(0, at, skewMs);
		}

		async function syncPosition(store: ReturnType<typeof buildNewStore>, serverTime: number) {
			await store.dispatch("room/sync", {
				action: "sync",
				currentSource: video,
				isPlaying: true,
				playbackPosition: 100,
				playbackSpeed: 2,
				serverTime,
			} as ServerMessageSync);
		}

		it("anchors the carried position at the instant the server sampled it", async () => {
			const store = buildNewStore();
			measureClock(0);
			// The message was sampled 800 ms ago; speed 2 means the room moved 1.6 s since.
			await syncPosition(store, Date.now() - 800);

			expect(roomPosition(store)).toBeCloseTo(101.6, 2);
		});

		it("arrives at the same anchor when the message is read late", async () => {
			const store = buildNewStore();
			measureClock(0);
			vi.advanceTimersByTime(500);
			await syncPosition(store, Date.now() - 800);

			// Reading it half a second late must not shift the clock by half a second: the
			// message says when its position was sampled, not when it was delivered.
			expect(roomPosition(store)).toBeCloseTo(101.6, 2);
		});

		it("places a server clock that runs ahead of ours on our clock", async () => {
			const store = buildNewStore();
			const skew = 60_000;
			measureClock(skew);
			await syncPosition(store, Date.now() + skew - 800);

			expect(roomPosition(store)).toBeCloseTo(101.6, 2);
		});

		it("falls back to the arrival anchor while no offset is known", async () => {
			const store = buildNewStore();
			expect(getServerClockOffsetMs()).toBeNull();
			// A legacy server sends no server time; nothing about this may change.
			await syncPosition(store, Date.now() - 800);

			expect(roomPosition(store)).toBeCloseTo(100, 2);
		});

		it("repairs a cold join when the offset arrives after the sync", async () => {
			const store = buildNewStore();
			const detach = attachServerClock(store);
			try {
				// The join's syncs are processed before the first pong, so the position was
				// anchored at arrival; nothing would ever repair that on its own.
				await syncPosition(store, Date.now() - 800);
				expect(roomPosition(store)).toBeCloseTo(100, 2);

				measureClock(0);

				expect(roomPosition(store)).toBeCloseTo(101.6, 2);
			} finally {
				detach();
			}
		});

		it("keeps compensating through the offset samples the connection keeps taking", async () => {
			const store = buildNewStore();
			const detach = attachServerClock(store);
			try {
				measureClock(0);
				await syncPosition(store, Date.now() - 800);
				expect(roomPosition(store)).toBeCloseTo(101.6, 2);

				// A later sample with a worse round trip must not drag the anchor backwards.
				noteLatencySample(400, Date.now(), 0);
				expect(roomPosition(store)).toBeCloseTo(101.6, 2);
			} finally {
				detach();
			}
		});

		it("stops listening when the subscription is removed", async () => {
			const store = buildNewStore();
			const detach = attachServerClock(store);
			detach();
			await syncPosition(store, Date.now() - 800);
			measureClock(0);

			expect(roomPosition(store)).toBeCloseTo(100, 2);
		});
	});
});
