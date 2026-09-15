import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const getThumbnailFrame = vi.fn();
vi.mock("../../../thumbnails.js", () => ({
	getThumbnailFrame: (...args: unknown[]) => getThumbnailFrame(...args),
	clearThumbnailCache: () => undefined,
}));

const { default: thumbnails } = await import("../../../api/thumbnails.js");

const app = express();
app.set("trust proxy", true);
app.use("/api/thumbnails", thumbnails);

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1024, 7)]);

describe("thumbnail frame endpoint", () => {
	it.each([
		["a missing url", { time: "1" }],
		["a missing time", { url: "https://example.com/a.mp4" }],
		["a negative time", { url: "https://example.com/a.mp4", time: "-1" }],
		["a non-numeric time", { url: "https://example.com/a.mp4", time: "soon" }],
		["an overlong url", { url: `https://example.com/${"x".repeat(2048)}`, time: "1" }],
	])("rejects %s", async (_name, query) => {
		await request(app)
			.get("/api/thumbnails/frame")
			.query(query)
			.set("X-Forwarded-For", "10.3.0.1")
			.expect(400);
		expect(getThumbnailFrame).not.toHaveBeenCalled();
	});

	it("serves a frame with a browser cache header", async () => {
		getThumbnailFrame.mockResolvedValueOnce({ jpeg, cached: true, time: 5 });
		const response = await request(app)
			.get("/api/thumbnails/frame")
			.query({ url: "https://example.com/a.mp4", time: "6.5" })
			.set("X-Forwarded-For", "10.3.0.4")
			.expect(200);
		expect(response.headers["content-type"]).toBe("image/jpeg");
		expect(response.headers["cache-control"]).toBe("private, max-age=3600");
		expect(getThumbnailFrame).toHaveBeenCalledWith("https://example.com/a.mp4", 6.5);
	});

	it("answers 404 when no frame could be extracted", async () => {
		getThumbnailFrame.mockResolvedValueOnce(null);
		await request(app)
			.get("/api/thumbnails/frame")
			.query({ url: "https://example.com/a.mp4", time: "1" })
			.set("X-Forwarded-For", "10.3.0.2")
			.expect(404);
	});

	it("answers 400 when the source is rejected", async () => {
		getThumbnailFrame.mockRejectedValueOnce(
			new Error("Media URL resolves to a private address"),
		);
		await request(app)
			.get("/api/thumbnails/frame")
			.query({ url: "http://127.0.0.1/a.mp4", time: "1" })
			.set("X-Forwarded-For", "10.3.0.5")
			.expect(400);
	});

	it("rate limits a scrub that keeps asking", async () => {
		getThumbnailFrame.mockResolvedValue(null);
		const address = "10.3.0.3";
		for (let i = 0; i < 30; i++) {
			await request(app)
				.get("/api/thumbnails/frame")
				.query({ url: "https://example.com/a.mp4", time: String(i * 5) })
				.set("X-Forwarded-For", address)
				.expect(404);
		}
		await request(app)
			.get("/api/thumbnails/frame")
			.query({ url: "https://example.com/a.mp4", time: "300" })
			.set("X-Forwarded-For", address)
			.expect(429);
	});
});
