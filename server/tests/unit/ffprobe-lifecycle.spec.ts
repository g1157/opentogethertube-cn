import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { PassThrough, Readable } from "node:stream";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnDiskPreviewFfprobe, StreamFfprobe } from "../../ffprobe.js";

let tempDirectory: string | undefined;

describe("ffprobe failure cleanup", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		if (tempDirectory) {
			await fs.rm(tempDirectory, { recursive: true, force: true });
			tempDirectory = undefined;
		}
	});

	it("removes the preview file and directory when downloading fails", async () => {
		const mkdtemp = fs.mkdtemp;
		vi.spyOn(fs, "mkdtemp").mockImplementation(async prefix => {
			tempDirectory = await mkdtemp(prefix);
			return tempDirectory;
		});
		vi.spyOn(axios, "get").mockRejectedValue(new Error("download refused"));
		const destroyHttp = vi.spyOn(http.Agent.prototype, "destroy");
		const destroyHttps = vi.spyOn(https.Agent.prototype, "destroy");

		await expect(
			new OnDiskPreviewFfprobe().getFileInfo("https://example.com/x.mp4"),
		).rejects.toThrow("download refused");
		expect(tempDirectory).toBeDefined();
		await expect(fs.stat(tempDirectory as string)).rejects.toMatchObject({ code: "ENOENT" });
		expect(destroyHttp).toHaveBeenCalled();
		expect(destroyHttps).toHaveBeenCalled();
	});

	it("releases download agents when streaming fails before ffprobe starts", async () => {
		vi.spyOn(axios, "get").mockRejectedValue(new Error("download refused"));
		const destroyHttp = vi.spyOn(http.Agent.prototype, "destroy");
		const destroyHttps = vi.spyOn(https.Agent.prototype, "destroy");
		await expect(new StreamFfprobe().getFileInfo("https://example.com/x.mp4")).rejects.toThrow(
			"download refused",
		);
		expect(destroyHttp).toHaveBeenCalled();
		expect(destroyHttps).toHaveBeenCalled();
	});

	it("rejects a failed spawn immediately and cancels its hard timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const source = new PassThrough();
		vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: {}, data: source });
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		});
		vi.spyOn(childProcess, "spawn").mockReturnValue(
			child as unknown as childProcess.ChildProcessWithoutNullStreams,
		);
		let outcome: unknown;
		const result = (async () => {
			try {
				await new StreamFfprobe().getFileInfo("https://example.com/x.mp4");
			} catch (error) {
				outcome = error;
			}
		})();
		await new Promise(resolve => setImmediate(resolve));
		child.emit("error", new Error("spawn ENOENT"));
		await new Promise(resolve => setImmediate(resolve));
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe("spawn ENOENT");
		expect(vi.getTimerCount()).toBe(0);
		expect(source.destroyed).toBe(true);
		await result;
	});

	it("pauses downloading when ffprobe's input buffer is full", async () => {
		const source = Readable.from(Array.from({ length: 64 }, () => Buffer.alloc(4096)));
		vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: {}, data: source });
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough({ highWaterMark: 1024 }),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		});
		vi.spyOn(childProcess, "spawn").mockReturnValue(
			child as unknown as childProcess.ChildProcessWithoutNullStreams,
		);
		const result = new StreamFfprobe().getFileInfo("https://example.com/x.mp4");
		await new Promise(resolve => setImmediate(resolve));
		const bufferedBytes = child.stdin.writableLength;
		child.stdout.emit("data", Buffer.from("{}"));
		child.emit("close", 0);
		await result;
		expect(bufferedBytes).toBeLessThanOrEqual(8192);
		expect(source.destroyed).toBe(true);
	});
});
