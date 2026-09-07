import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import status from "../../../api/status.js";

describe("public client version endpoint", () => {
	let previousRevision: string | undefined;
	const app = express();
	app.use("/api/status", status);
	beforeEach(() => {
		previousRevision = process.env.OTT_CLIENT_REVISION;
	});
	afterEach(() => {
		if (previousRevision === undefined) {
			delete process.env.OTT_CLIENT_REVISION;
		} else {
			process.env.OTT_CLIENT_REVISION = previousRevision;
		}
	});

	it("returns only the public revision without authentication and prohibits caching", async () => {
		const revision = "0123456789abcdef0123456789abcdef01234567";
		process.env.OTT_CLIENT_REVISION = revision;
		const response = await request(app).get("/api/status/version").expect(200);
		expect(Object.keys(response.body)).toEqual(["revision"]);
		expect(response.body.revision).toBe(revision);
		expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
		expect(response.headers.pragma).toBe("no-cache");
		expect(response.headers.expires).toBe("0");
	});

	it("returns null when no deployed client revision is configured", async () => {
		delete process.env.OTT_CLIENT_REVISION;
		const response = await request(app).get("/api/status/version").expect(200);
		expect(Object.keys(response.body)).toEqual(["revision"]);
		expect(response.body.revision).toBeNull();
	});

	it("returns the new revision when a client sends the previous version's ETag", async () => {
		process.env.OTT_CLIENT_REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const previous = await request(app).get("/api/status/version").expect(200);
		process.env.OTT_CLIENT_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const current = await request(app)
			.get("/api/status/version")
			.set("If-None-Match", previous.headers.etag)
			.expect(200);
		expect(current.body.revision).toBe(process.env.OTT_CLIENT_REVISION);
		expect(current.headers["cache-control"]).toBe("no-store, max-age=0");
	});
});
