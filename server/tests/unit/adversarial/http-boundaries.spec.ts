import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { main } from "../../../app.js";
import InfoExtract from "../../../infoextractor.js";
import { MAX_PREVIEW_LINES } from "ott-common/constants.js";

describe("HTTP attack surface boundaries", () => {
	let app: any;
	let ipSequence = 0;
	const nextIp = () => `10.10.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`;

	beforeAll(async () => {
		app = (await main()).app;
		// Supertest always connects from loopback; make each probe its own client so the
		// per-IP budgets do not turn one test into another test's 429.
		app.set("trust proxy", 1);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects an oversized JSON body before it reaches a handler", async () => {
		const response = await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send(JSON.stringify({ padding: "x".repeat(200_000) }));
		expect([400, 413]).toContain(response.status);
	});

	it("does not let a __proto__ key in a JSON body pollute Object.prototype", async () => {
		const response = await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send(
				JSON.stringify({
					service: "direct",
					startup: 1,
					rebuffers: 0,
					rebufferSeconds: 0,
					playSeconds: 10,
					seeks: 0,
					errors: 0,
					__proto__: { polluted: true },
				}),
			);
		expect([204, 400]).toContain(response.status);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("rejects quality reports with out-of-range counters", async () => {
		const response = await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send({
				service: "direct",
				startup: 1,
				rebuffers: 1_000_000_000,
				rebufferSeconds: -1,
				playSeconds: 10,
				seeks: 0,
				errors: 0,
			});
		expect(response.status).toBe(400);
	});

	it("rejects an oversized service label instead of turning it into a metric label", async () => {
		const response = await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send({
				service: "x".repeat(1000),
				startup: 1,
				rebuffers: 0,
				rebufferSeconds: 0,
				playSeconds: 10,
				seeks: 0,
				errors: 0,
			});
		expect(response.status).toBe(400);
	});

	it("accepts the anonymous quality beacon for a well-formed report", async () => {
		const response = await request(app)
			.post("/api/playback/quality")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send({
				service: "direct",
				startup: 1,
				rebuffers: 0,
				rebufferSeconds: 0,
				playSeconds: 10,
				seeks: 0,
				errors: 0,
			});
		expect(response.status).toBe(204);
	});

	it("rejects an array-valued preview input with 400, not a handler crash", async () => {
		const resolve = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue({ videos: [], cacheDuration: 0 } as any);

		const response = await request(app)
			.get("/api/data/previewAdd")
			.set("X-Forwarded-For", nextIp())
			.query([
				["input", "https://example.com/a.mp4"],
				["input", "https://example.com/b.mp4"],
			]);

		expect(response.status).toBe(400);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects a missing preview input with 400", async () => {
		const response = await request(app)
			.get("/api/data/previewAdd")
			.set("X-Forwarded-For", nextIp());
		expect(response.status).toBe(400);
	});

	it("caps a multi-line series probe before it reaches the probe fan-out", async () => {
		const getMany = vi.spyOn(InfoExtract, "getManyVideoInfo").mockResolvedValue([]);
		const input = Array.from(
			{ length: MAX_PREVIEW_LINES + 1 },
			(_, index) => `https://example.com/episode-${index}.mp4`,
		).join("\n");

		await expect(InfoExtract.resolveVideoQueryImpl(input, "youtube")).rejects.toThrow();
		expect(getMany).not.toHaveBeenCalled();
	});

	it.each([
		["path traversal", { page: "/../../etc/passwd" }],
		["an array", { page: ["/playGV1-1-1/", "/playGV1-1-2/"] }],
		["a full URL", { page: "https://evil.example/" }],
	])("rejects danmaku track %s", async (_label, query) => {
		const response = await request(app)
			.get("/api/danmaku/girigiri/track")
			.set("X-Forwarded-For", nextIp())
			.query(query);
		expect(response.status).toBe(400);
	});

	it("rejects a malformed undo body with 400 instead of crashing the handler", async () => {
		const grant = await request(app).get("/api/auth/grant").set("X-Forwarded-For", nextIp());
		const token = grant.body.token;
		expect(typeof token).toBe("string");

		const response = await request(app)
			.post("/api/room/whatever/undo")
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`)
			.send({ data: {} });
		expect(response.status).toBe(400);
	});

	it("does not hang on a login body the parser did not populate", async () => {
		const response = await request(app)
			.post("/api/user/login")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "text/plain")
			.send("hello")
			.timeout({ response: 2000, deadline: 4000 });
		expect([400, 401, 413]).toContain(response.status);
	});

	it("rejects malformed JSON before the login handler", async () => {
		const response = await request(app)
			.post("/api/user/login")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send('{"user":');
		expect([400, 401, 413]).toContain(response.status);
	});

	it("does not pollute Object.prototype through a form-encoded body", async () => {
		const response = await request(app)
			.post("/api/user/login")
			.set("X-Forwarded-For", nextIp())
			.type("form")
			.send("__proto__[polluted]=true&user=nobody&password=wrong");
		expect([400, 401, 429]).toContain(response.status);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("rejects oversized danmaku search terms", async () => {
		const response = await request(app)
			.get("/api/danmaku/girigiri/search")
			.set("X-Forwarded-For", nextIp())
			.query({ wd: "x".repeat(65) });
		expect(response.status).toBe(400);
	});
});
