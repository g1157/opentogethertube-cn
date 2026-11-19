import express from "express";
import request from "supertest";
import { RateLimiterRes } from "rate-limiter-flexible";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildRateLimiter, handleRateLimit, setRateLimitHeaders } from "../../rate-limit.js";

describe("rate limit response headers", () => {
	beforeAll(() => {
		buildRateLimiter();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function localizeDate() {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
		vi.spyOn(Date.prototype, "toString").mockReturnValue(
			"Thu Nov 19 2026 08:00:30 GMT+0800 (China Standard Time / \u4e2d\u56fd\u6807\u51c6\u65f6\u95f4)",
		);
	}

	it("sends an ASCII HTTP date even with a non-ASCII local timezone name", async () => {
		localizeDate();
		const app = express();
		app.get("/", (_req, res) => {
			setRateLimitHeaders(res, new RateLimiterRes(9, 30_000, 1, true));
			res.sendStatus(204);
		});

		const response = await request(app).get("/").expect(204);
		expect(response.headers["x-ratelimit-reset"]).toBe("Thu, 19 Nov 2026 00:00:30 GMT");
		expect(response.headers["x-ratelimit-remaining"]).toBe("9");
	});

	it("sends a complete 429 response instead of throwing while writing headers", async () => {
		localizeDate();
		const app = express();
		app.get("/", (_req, res) => {
			handleRateLimit(res, new RateLimiterRes(0, 30_000, 10, false));
		});

		const response = await request(app).get("/").expect(429);
		expect(response.headers["retry-after"]).toBe("30");
		expect(response.headers["x-ratelimit-reset"]).toBe("Thu, 19 Nov 2026 00:00:30 GMT");
		expect(response.body.error.name).toBe("TooManyRequests");
	});
});
