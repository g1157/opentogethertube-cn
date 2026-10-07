import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaybackQuality, type PlaybackQualityReport } from "@/util/playback-quality";

describe("playback quality measurement", () => {
	let now: number;
	let sent: PlaybackQualityReport[];
	let quality: ReturnType<typeof createPlaybackQuality>;

	beforeEach(() => {
		now = 0;
		sent = [];
		quality = createPlaybackQuality({
			service: () => "hls",
			send: report => sent.push(report),
			now: () => now,
		});
	});

	function playFromFirstFrame() {
		quality.noteSourceChanged("hls");
		now += 1000;
		quality.notePlaying(true);
	}

	it("reports nothing before a source has played long enough", () => {
		quality.noteSourceChanged("hls");
		quality.flush();
		expect(sent).toHaveLength(0);
	});

	it("measures startup from the source load to the first frame", () => {
		quality.noteSourceChanged("hls");
		now += 2500;
		quality.notePlaying(true);
		now += 10_000;
		quality.flush();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ service: "hls", startup: 2.5, playSeconds: 10 });
	});

	it("counts a stall after playback started but not the first load", () => {
		playFromFirstFrame();
		quality.noteBuffering(true);
		expect(sent).toHaveLength(0);
		now += 4000;
		quality.noteBuffering(false);
		now += 20_000;
		quality.flush();
		expect(sent[0]).toMatchObject({ rebuffers: 1, rebufferSeconds: 4, playSeconds: 20 });
	});

	it("excludes stalled time from played time", () => {
		playFromFirstFrame();
		now += 10_000;
		quality.noteBuffering(true);
		now += 60_000;
		quality.noteBuffering(false);
		now += 1000;
		quality.flush();
		expect(sent[0].playSeconds).toBe(11);
	});

	it("ignores a buffering signal during the initial load", () => {
		quality.noteSourceChanged("hls");
		quality.noteBuffering(true);
		now += 3000;
		quality.noteBuffering(false);
		now += 1000;
		quality.notePlaying(true);
		now += 10_000;
		quality.flush();
		expect(sent[0]).toMatchObject({ startup: 4, rebuffers: 0 });
	});

	it("counts seeks and errors between reports", () => {
		playFromFirstFrame();
		quality.noteSeek();
		quality.noteSeek();
		quality.noteError();
		now += 10_000;
		quality.flush();
		expect(sent[0]).toMatchObject({ seeks: 2, errors: 1 });
	});

	it("reports the previous source when the room switches video", () => {
		playFromFirstFrame();
		now += 30_000;
		quality.noteSourceChanged("direct");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ service: "hls", playSeconds: 30 });
		now += 1000;
		quality.notePlaying(true);
		now += 10_000;
		quality.flush();
		expect(sent[1]).toMatchObject({ service: "direct", startup: 1 });
	});

	it("keeps measuring after a mid-session flush", () => {
		playFromFirstFrame();
		now += 10_000;
		quality.flush();
		now += 10_000;
		quality.flush();
		expect(sent.map(report => report.playSeconds)).toEqual([10, 10]);
	});

	it("reports zeros when the sync and frame counters are unavailable", () => {
		playFromFirstFrame();
		now += 10_000;
		quality.flush();
		expect(sent[0]).toMatchObject({
			rateWrites: 0,
			deadlineSeeks: 0,
			maxDriftSeconds: 0,
			totalFrames: 0,
			droppedFrames: 0,
		});
	});

	it("reports per-window deltas of the sync and frame counters", () => {
		const sync = { rateWrites: 0, deadlineSeeks: 0, maxAbsDrift: 0.6 };
		const frames = { total: 0, dropped: 0 };
		quality = createPlaybackQuality({
			service: () => "hls",
			send: report => sent.push(report),
			now: () => now,
			getSyncCounters: () => sync,
			getFrameQuality: () => frames,
		});
		playFromFirstFrame();
		sync.rateWrites += 240;
		sync.deadlineSeeks += 2;
		sync.maxAbsDrift = 1.4;
		frames.total += 6000;
		frames.dropped += 37;
		now += 10_000;
		quality.flush();
		expect(sent[0]).toMatchObject({
			rateWrites: 240,
			deadlineSeeks: 2,
			maxDriftSeconds: 1.4,
			totalFrames: 6000,
			droppedFrames: 37,
		});

		// A mid-session window reports only its own growth.
		sync.rateWrites += 60;
		sync.deadlineSeeks += 1;
		frames.total += 1500;
		frames.dropped += 3;
		now += 10_000;
		quality.flush();
		expect(sent[1]).toMatchObject({
			rateWrites: 60,
			deadlineSeeks: 1,
			totalFrames: 1500,
			droppedFrames: 3,
		});

		// A counter that went backwards was reset (a new source, a reloaded element);
		// its whole value belongs to this window.
		sync.rateWrites = 25;
		sync.deadlineSeeks = 0;
		frames.total = 400;
		frames.dropped = 1;
		now += 10_000;
		quality.flush();
		expect(sent[2]).toMatchObject({
			rateWrites: 25,
			deadlineSeeks: 0,
			totalFrames: 400,
			droppedFrames: 1,
		});
	});
});
