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
});
