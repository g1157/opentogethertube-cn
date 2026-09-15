import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { register } from "prom-client";
import playback, { isRateLimited } from "../../../api/playback.js";

const app = express();
// Behind the real deployment the tunnel would hide every viewer behind one address, so the
// tests exercise the same header-based address Express sees when TRUST_PROXY is on.
app.set("trust proxy", true);
app.use(express.json());
app.use("/api/playback", playback);

const report = {
	service: "hls",
	startup: 1.5,
	rebuffers: 2,
	rebufferSeconds: 8.5,
	playSeconds: 600,
	seeks: 3,
	errors: 1,
};

describe("playback quality reports", () => {
	it("records an accepted report in the metrics registry", async () => {
		const service = "hls-accepted";
		await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", "10.1.0.1")
			.send({ ...report, service })
			.expect(204);
		const metrics = await register.metrics();
		expect(metrics).toContain(`ott_playback_play_seconds{service="${service}"} 600`);
		expect(metrics).toContain(`ott_playback_rebuffers{service="${service}"} 2`);
		expect(metrics).toContain(`ott_playback_rebuffer_seconds{service="${service}"} 8.5`);
		expect(metrics).toContain(`ott_playback_startup_samples{service="${service}"} 1`);
		expect(metrics).toContain(`ott_playback_startup_seconds_count{service="${service}"} 1`);
		expect(metrics).toContain(`ott_playback_seeks{service="${service}"} 3`);
		expect(metrics).toContain(`ott_playback_errors{service="${service}"} 1`);
	});

	it("accepts a report that never reached a first frame", async () => {
		await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", "10.1.0.2")
			.send({ ...report, service: "direct", startup: null, rebuffers: 0 })
			.expect(204);
		const metrics = await register.metrics();
		expect(metrics).not.toContain('ott_playback_startup_seconds_count{service="direct"}');
	});

	const rejected: Array<[string, object, string]> = [
		["an empty service", { ...report, service: "" }, "10.1.1.1"],
		["a negative play time", { ...report, playSeconds: -1 }, "10.1.1.2"],
		["a startup beyond a day", { ...report, startup: 24 * 60 * 60 + 1 }, "10.1.1.3"],
		["a fractional rebuffer count", { ...report, rebuffers: 1.5 }, "10.1.1.4"],
		["an unknown field type", { ...report, seeks: "3" }, "10.1.1.5"],
		["an empty body", {}, "10.1.1.6"],
	];
	it.each(rejected)("rejects %s", async (_name, body, address) => {
		await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", address)
			.send(body)
			.expect(400);
	});

	it("rate limits repeat reports from one address", async () => {
		const address = "10.1.0.3";
		await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", address)
			.send(report)
			.expect(204);
		await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", address)
			.send(report)
			.expect(429);
	});
});

describe("playback report rate limiter", () => {
	it("allows one report per interval per address", () => {
		const address = "10.2.0.1";
		const now = Date.now();
		expect(isRateLimited(address, now)).toBe(false);
		expect(isRateLimited(address, now + 4999)).toBe(true);
		expect(isRateLimited(address, now + 5000)).toBe(false);
		expect(isRateLimited("10.2.0.2", now + 5000)).toBe(false);
	});
});
