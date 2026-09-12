import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { installSecurityHeaders } from "../../security-headers.js";
import { buildRateLimiter, rateLimiter } from "../../rate-limit.js";
import { conf } from "../../ott-config.js";

const logger = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));
vi.mock("../../logger.js", () => ({ getLogger: () => logger }));
const CSP_BUCKET = /^csp-report:/;
const RETRY_AFTER = /\d+/;

describe("security headers and CSP reporting", () => {
	let app: express.Express;
	let previousEnabled: boolean;
	const report = {
		"csp-report": {
			"effective-directive": "object-src",
			"document-uri": "https://viewer:secret@example.test/room/private?token=secret#private",
			"blocked-uri": "https://media.example.test/private.mp4?signature=secret",
			"source-file": "data:text/javascript,secret",
			"original-policy": "secret policy sample",
			"script-sample": "secret script sample",
		},
	};
	const sendReport = (body: unknown = report) =>
		request(app)
			.post("/watch/api/csp-report")
			.set("Content-Type", "application/csp-report")
			.send(JSON.stringify(body));

	beforeAll(() => {
		previousEnabled = conf.get("rate_limit.enabled");
		conf.set("rate_limit.enabled", true);
	});
	beforeEach(() => {
		vi.clearAllMocks();
		buildRateLimiter();
		app = express();
		installSecurityHeaders(app, "/watch");
		app.get("/watch/", (_req, res) => res.type("html").send("<html>test</html>"));
		app.get("/watch/assets/app.js", (_req, res) => res.type("js").send("/* test */"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(() => {
		conf.set("rate_limit.enabled", previousEnabled);
	});

	it.each([
		{ path: "/watch/", enforced: undefined },
		{ path: "/watch/assets/app.js", enforced: undefined },
		// Express already restricts its generated 404 document; leave that existing behavior intact.
		{ path: "/watch/api/not-found", enforced: "default-src 'none'" },
	])("adds minimal headers to $path and preserves existing error-page policy", async ({
		path,
		enforced,
	}) => {
		const response = await request(app).get(path);
		expect(response.headers["x-powered-by"]).toBeUndefined();
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
		expect(response.headers["permissions-policy"]).toBe(
			"camera=(), microphone=(), geolocation=()",
		);
		expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
		expect(response.headers["content-security-policy"]).toBe(enforced);
		expect(response.headers["content-security-policy-report-only"]).toContain(
			"report-uri /watch/api/csp-report",
		);
		expect(response.headers["content-security-policy-report-only"]).not.toContain("script-src");
		expect(response.headers["strict-transport-security"]).toBeUndefined();
	});

	it.each([
		{ trust: 0, protocol: "https", hsts: undefined },
		{ trust: 1, protocol: "http", hsts: undefined },
		{ trust: 1, protocol: "https", hsts: "max-age=31536000; includeSubDomains" },
	])("uses Express HTTPS detection with trust=$trust and XFP=$protocol", async ({
		trust,
		protocol,
		hsts,
	}) => {
		app.set("trust proxy", trust);
		const response = await request(app).get("/watch/").set("X-Forwarded-Proto", protocol);
		expect(response.headers["strict-transport-security"]).toBe(hsts);
	});

	it("accepts a browser report and logs only a bounded directive and origins", async () => {
		await sendReport().expect(204);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'CSP report: {"directive":"object-src","documentOrigin":"https://example.test","blockedOrigin":"https://media.example.test","sourceOrigin":"other"}',
		);
	});

	it("supports the legacy violated-directive field and inline marker without logging the policy", async () => {
		await sendReport({
			"csp-report": {
				"violated-directive": "script-src 'self' https://private.test",
				"blocked-uri": "inline",
			},
		}).expect(204);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'CSP report: {"directive":"script-src","blockedOrigin":"inline"}',
		);
	});

	it.each([
		{},
		{ "csp-report": [] },
		{ "csp-report": {} },
		{ "csp-report": { "effective-directive": "\nsecret injection" } },
	])("rejects an invalid report shape %#", async body => {
		await sendReport(body).expect(400);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("rejects unexpected content types", async () => {
		await request(app).post("/watch/api/csp-report").send(report).expect(415);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("rejects reports larger than 16 KiB before logging", async () => {
		await sendReport({ ...report, padding: "x".repeat(17000) }).expect(413);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("does not echo or log malformed JSON", async () => {
		const response = await request(app)
			.post("/watch/api/csp-report")
			.set("Content-Type", "application/csp-report")
			.send('{"secret":')
			.expect(400);
		expect(response.text).not.toContain("secret");
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("uses the existing limiter in a separate IP bucket before parsing or logging", async () => {
		const consume = vi.spyOn(rateLimiter, "consume");
		const response = await sendReport().expect(204);
		const [key, points] = consume.mock.calls[0];
		expect(key).toMatch(CSP_BUCKET);
		expect(points).toBe(25);
		await rateLimiter.consume(key, Number(response.headers["x-ratelimit-remaining"]));
		await sendReport().expect(429).expect("Retry-After", RETRY_AFTER);
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});
});
