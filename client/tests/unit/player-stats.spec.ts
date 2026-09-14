import { describe, expect, it } from "vitest";
import {
	bufferAhead,
	collectPlayerStats,
	type PlayerStatsInput,
	type PlayerStatsRow,
	type PlayerStatsSection,
	secondsToTimestamp,
} from "@/components/composables/player-stats";

function fakeVideo(options: { currentTime?: number; paused?: boolean; readyState?: number } = {}) {
	const video = document.createElement("video");
	Object.defineProperties(video, {
		videoWidth: { value: 1280, configurable: true },
		videoHeight: { value: 720, configurable: true },
		duration: { value: 600, configurable: true },
		currentTime: { value: options.currentTime ?? 10, configurable: true, writable: true },
		paused: { value: options.paused ?? false, configurable: true },
		readyState: { value: options.readyState ?? 4, configurable: true },
		playbackRate: { value: 1, configurable: true },
		buffered: {
			value: { length: 1, start: () => 0, end: () => 30 },
			configurable: true,
		},
	});
	video.getBoundingClientRect = () =>
		({
			width: 2560,
			height: 1440,
			top: 0,
			left: 0,
			right: 2560,
			bottom: 1440,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
	// jsdom has no playback quality API.
	(video as unknown as { getVideoPlaybackQuality: () => object }).getVideoPlaybackQuality =
		() => ({
			droppedVideoFrames: 3,
			totalVideoFrames: 1000,
		});
	return video;
}

function baseInput(overrides: Partial<PlayerStatsInput> = {}): PlayerStatsInput {
	return {
		video: fakeVideo(),
		measuredFps: 59.5,
		now: 1_000_000,
		room: {
			isPlaying: true,
			playbackPosition: 0,
			// The room set its position 10 seconds ago, so it sits at 10s.
			playbackStartTimeMs: 1_000_000 - 10_000,
			playbackSpeed: 1,
			sourceId: "https://cdn.example.com/anime/ep1.m3u8",
			sourceService: "hls",
		},
		settings: { upscaleMode: "sharpen", upscaleScale: "auto", upscaleAutoDegrade: true },
		enhancement: { target: null, error: null },
		device: {
			dpr: 1,
			viewportWidth: 2560,
			viewportHeight: 1440,
			webgpu: true,
			gpuName: "nvidia ampere",
		},
		...overrides,
	};
}

function rowOf(sections: PlayerStatsSection[], labelKey: string): PlayerStatsRow {
	for (const section of sections) {
		for (const row of section.rows) {
			if (row.labelKey === labelKey) {
				return row;
			}
		}
	}
	throw new Error(`no row for ${labelKey}`);
}

describe("playback details", () => {
	it("reports the source, the playback state and the render target", () => {
		const sections = collectPlayerStats(baseInput());

		expect(rowOf(sections, "player.stats.resolution").value).toBe("1280×720");
		expect(rowOf(sections, "player.stats.source-type").value).toBe("hls");
		expect(rowOf(sections, "player.stats.source-host").value).toBe("cdn.example.com");
		expect(rowOf(sections, "player.stats.state").valueKey).toBe("player.stats.state-playing");
		expect(rowOf(sections, "player.stats.render-fps").value).toBe("59.5 fps");
		expect(rowOf(sections, "player.stats.dropped").value).toBe("3 / 1000");
		expect(rowOf(sections, "player.stats.buffer-ahead").params).toEqual({ value: "20.0" });
		// Auto follows the displayed 2560x1440 box, which is a 2x render of the 720p source.
		expect(rowOf(sections, "player.stats.render-target").value).toBe("2560×1440（2.00×）");
		expect(rowOf(sections, "player.stats.mode").valueKey).toBe("room.upscale.sharpen");
		expect(rowOf(sections, "player.stats.webgpu").value).toBe("nvidia ampere");
	});

	it("reports no video when the player is an embedded one", () => {
		const sections = collectPlayerStats(
			baseInput({ video: undefined, measuredFps: null, room: { ...baseInput().room } }),
		);

		expect(rowOf(sections, "player.stats.resolution").value).toBe("—");
		expect(rowOf(sections, "player.stats.state").valueKey).toBe("player.stats.state-unknown");
		expect(rowOf(sections, "player.stats.render-target").value).toBe("—");
		expect(rowOf(sections, "player.stats.render-fps").value).toBe("—");
	});

	it("reports buffering only while playing, and keeps a paused player paused", () => {
		// Buffering means frames are wanted but not arriving; a paused element that has
		// not filled its buffer yet is simply paused.
		const buffering = collectPlayerStats(
			baseInput({ video: fakeVideo({ paused: false, readyState: 2 }) }),
		);
		expect(rowOf(buffering, "player.stats.state").valueKey).toBe(
			"player.stats.state-buffering",
		);

		const paused = collectPlayerStats(
			baseInput({ video: fakeVideo({ paused: true, readyState: 2 }) }),
		);
		expect(rowOf(paused, "player.stats.state").valueKey).toBe("player.stats.state-paused");
	});

	it("reports how far this device sits from the room position", () => {
		// The room is half a second ahead of the element's own position.
		const input = baseInput();
		input.room.playbackStartTimeMs = 1_000_000 - 10_500;
		const sections = collectPlayerStats(input);

		expect(rowOf(sections, "player.stats.drift").params).toEqual({ value: "+0.50" });

		input.room.isPlaying = false;
		expect(rowOf(collectPlayerStats(input), "player.stats.drift").value).toBe("—");
	});

	it("formats timestamps and reports the buffered span", () => {
		expect(secondsToTimestamp(0)).toBe("0:00");
		expect(secondsToTimestamp(65)).toBe("1:05");
		expect(secondsToTimestamp(3661)).toBe("1:01:01");
		expect(secondsToTimestamp(Number.NaN)).toBe("—");
		expect(secondsToTimestamp(-1)).toBe("—");

		expect(bufferAhead(fakeVideo({ currentTime: 10 }))).toBe(20);
		expect(bufferAhead(fakeVideo({ currentTime: 50 }))).toBeNull();
	});
});
