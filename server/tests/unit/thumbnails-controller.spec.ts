import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawn = vi.fn();
vi.mock("node:child_process", () => ({
	default: { spawn: (...args: unknown[]) => spawn(...args) },
}));
vi.mock("../../ffprobe.js", () => ({
	assertPublicMediaUrl: vi.fn(async () => undefined),
}));

const { getThumbnailFrame, clearThumbnailCache } = await import("../../thumbnails.js");

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1024, 3)]);

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	// A hand-built fake, not a real child: there is no method to spy on.
	// eslint-disable-next-line vitest/prefer-spy-on
	child.kill = vi.fn();
	return child;
}

/** Answer the next spawn immediately, as a working ffmpeg would. */
function respondWith(output: Buffer) {
	spawn.mockImplementationOnce(() => {
		const child = fakeChild();
		setImmediate(() => {
			if (output.length > 0) {
				child.stdout.emit("data", output);
			}
			child.emit("close", 0);
		});
		return child;
	});
}

describe("thumbnail extraction controller", () => {
	beforeEach(() => {
		clearThumbnailCache();
		spawn.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs ffmpeg with a bounded, stdout-only command", async () => {
		respondWith(jpeg);
		const result = await getThumbnailFrame("https://cdn.example.com/a.mp4", 12.5);
		expect(result).toMatchObject({ cached: false, time: 10 });
		expect(result?.jpeg.equals(jpeg)).toBe(true);
		const [command, args] = spawn.mock.calls[0];
		expect(command).toBe("ffmpeg");
		expect(args).toContain("-ss");
		expect(args[args.indexOf("-ss") + 1]).toBe("12.500");
		expect(args).toContain("pipe:1");
		expect(args).toContain("-rw_timeout");
	});

	it("serves a repeat request from the cache without spawning again", async () => {
		respondWith(jpeg);
		await getThumbnailFrame("https://cdn.example.com/a.mp4", 12.5);
		const second = await getThumbnailFrame("https://cdn.example.com/a.mp4", 13.9);
		expect(second?.cached).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("shares one extraction between concurrent requests for the same bucket", async () => {
		respondWith(jpeg);
		const [a, b] = await Promise.all([
			getThumbnailFrame("https://cdn.example.com/a.mp4", 20),
			getThumbnailFrame("https://cdn.example.com/a.mp4", 24),
		]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect([a?.cached, b?.cached].filter(cached => cached === false)).toHaveLength(1);
	});

	it("treats an empty or truncated reply as no frame", async () => {
		respondWith(Buffer.from([0xff, 0xd8]));
		expect(await getThumbnailFrame("https://cdn.example.com/a.mp4", 30)).toBeNull();
		respondWith(Buffer.alloc(0));
		expect(await getThumbnailFrame("https://cdn.example.com/b.mp4", 30)).toBeNull();
	});

	it("kills a stalled extraction at the hard timeout", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		spawn.mockImplementationOnce(() => child);
		const pending = getThumbnailFrame("https://cdn.example.com/a.mp4", 40);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(await pending).toBeNull();
	});

	it("stops spawning once ffmpeg is known to be missing", async () => {
		spawn.mockImplementationOnce(() => {
			const child = fakeChild();
			setImmediate(() => {
				const error = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				child.emit("error", error);
			});
			return child;
		});
		expect(await getThumbnailFrame("https://cdn.example.com/a.mp4", 50)).toBeNull();
		respondWith(jpeg);
		expect(await getThumbnailFrame("https://cdn.example.com/a.mp4", 60)).toBeNull();
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
