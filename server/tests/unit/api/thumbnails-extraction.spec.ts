import { afterAll, beforeAll, describe, expect, it } from "vitest";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearThumbnailCache, getThumbnailFrame } from "../../../thumbnails.js";

function hasFfmpeg(): boolean {
	try {
		return childProcess.spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

// The deployment images ship ffmpeg; a development machine may not.
describe.skipIf(!hasFfmpeg())("thumbnail extraction", () => {
	let directory: string;
	let videoPath: string;

	beforeAll(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "ott-thumbnails-"));
		videoPath = path.join(directory, "fixture.mp4");
		// A few seconds of synthetic video keeps the test independent of the network.
		childProcess.execFileSync("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=3:size=320x240:rate=10",
			"-pix_fmt",
			"yuv420p",
			"-y",
			videoPath,
		]);
	});

	afterAll(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it("extracts a jpeg and serves the same time bucket from the cache", async () => {
		clearThumbnailCache();
		const url = `file://${videoPath}`;
		const first = await getThumbnailFrame(url, 1);
		expect(first).not.toBeNull();
		expect(first?.cached).toBe(false);
		expect(first?.jpeg[0]).toBe(0xff);
		expect(first?.jpeg[1]).toBe(0xd8);
		expect(first?.jpeg.length).toBeGreaterThan(512);
		// Two seconds later asks for the same five second bucket.
		const second = await getThumbnailFrame(url, 2);
		expect(second?.cached).toBe(true);
		// Past the end of the video there is no frame to serve.
		expect(await getThumbnailFrame(url, 60)).toBeNull();
	});

	it("makes concurrent requests for one bucket share a single extraction", async () => {
		clearThumbnailCache();
		const url = `file://${videoPath}`;
		const [a, b, c] = await Promise.all([
			getThumbnailFrame(url, 10),
			getThumbnailFrame(url, 11),
			getThumbnailFrame(url, 12),
		]);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(c).not.toBeNull();
		// Exactly one of them did the work; the others waited on it.
		expect([a?.cached, b?.cached, c?.cached].filter(cached => cached === false)).toHaveLength(
			1,
		);
		expect(b?.jpeg.equals(a!.jpeg)).toBe(true);
	});
});
