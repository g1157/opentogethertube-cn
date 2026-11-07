import { describe, expect, it } from "vitest";
import { bufferGrowth, collectPlaybackDiagnostics } from "@/util/playback-diagnostics";

function fakeVideo(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
	return {
		paused: false,
		readyState: 4,
		networkState: 2,
		error: null,
		getVideoPlaybackQuality: () => ({
			totalVideoFrames: 100,
			droppedVideoFrames: 3,
		}),
		...overrides,
	} as unknown as HTMLVideoElement;
}

describe("playback diagnostics", () => {
	it("measures buffer growth per wall second", () => {
		expect(bufferGrowth({ at: 1000, bufferAhead: 5 }, 6000, 15)).toBe(2);
		expect(bufferGrowth({ at: 1000, bufferAhead: 5 }, 6000, 5)).toBe(0);
	});

	it("does not report a download rate across a seek or a missing sample", () => {
		expect(bufferGrowth({ at: 1000, bufferAhead: 20 }, 6000, 1)).toBeNull();
		expect(bufferGrowth({ at: 1000, bufferAhead: null }, 6000, 10)).toBeNull();
		expect(bufferGrowth(null, 6000, 10)).toBeNull();
		expect(bufferGrowth({ at: 6000, bufferAhead: 5 }, 6000, 10)).toBeNull();
	});

	it("keeps the source host but never the full signed URL", () => {
		const diagnostics = collectPlaybackDiagnostics({
			video: fakeVideo(),
			source: {
				service: "hls",
				id: "https://media.example.test/path/master.m3u8?token=secret",
			},
			playerKind: "native",
			hidden: false,
			autoplayBlocked: false,
			recovering: false,
			seeking: false,
			bufferAhead: 15,
			previous: { at: 1000, bufferAhead: 5 },
			quality: { startup: 2.5, rebuffers: 1, rebufferSeconds: 4, playSeconds: 30 },
			sync: { rateWrites: 2, deadlineSeeks: 1, maxAbsDrift: 0.8 },
			wsRttMs: 42,
			connection: {
				effectiveType: "4g",
				downlink: 1.2,
				rtt: 180,
				saveData: false,
			},
			hls: { bandwidthKbps: 1800, levelHeight: 720, levelCount: 3 },
			now: 6000,
		});

		expect(diagnostics).toMatchObject({
			sampledAt: 6000,
			service: "hls",
			sourceHost: "media.example.test",
			bufferAhead: 15,
			bufferGrowth: 2,
			startup: 2.5,
			rebuffers: 1,
			playSeconds: 30,
			wsRttMs: 42,
			connectionEffectiveType: "4g",
			connectionDownlinkMbps: 1.2,
			connectionRttMs: 180,
			hlsBandwidthKbps: 1800,
			hlsLevelHeight: 720,
			hlsLevelCount: 3,
			totalFrames: 100,
			droppedFrames: 3,
		});
		expect(JSON.stringify(diagnostics)).not.toContain("secret");
		expect(JSON.stringify(diagnostics)).not.toContain("/path/");
	});

	it("reports hidden tabs and blocked autoplay instead of treating them as buffering", () => {
		const diagnostics = collectPlaybackDiagnostics({
			video: fakeVideo({ paused: true }),
			source: { service: "direct", id: "https://cdn.example.test/video.mp4" },
			playerKind: "native",
			hidden: true,
			autoplayBlocked: true,
			recovering: false,
			seeking: false,
			bufferAhead: null,
			connection: null,
		});
		expect(diagnostics.hidden).toBe(true);
		expect(diagnostics.autoplayBlocked).toBe(true);
		expect(diagnostics.paused).toBe(true);
		expect(diagnostics.bufferAhead).toBeNull();
		expect(diagnostics.connectionEffectiveType).toBeUndefined();
	});
});
