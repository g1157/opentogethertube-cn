import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { clientStaticFiles, setNoStoreHeaders } from "../../client-assets.js";

describe("client asset cache policy", () => {
	let directory: string;
	let app: express.Express;
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "ott-client-cache-"));
		await mkdir(join(directory, "assets"));
		await Promise.all(
			[
				"index.html",
				"source-code.tar.gz",
				"favicon.ico",
				"assets/runtime.js",
				"outside-Ab12_cD3.js",
				"assets/player-Ab12_cD3.js",
				"assets/styles-ABc123_4.css",
			].map(file => writeFile(join(directory, file), "original test content")),
		);
		app = express();
		app.use("/watch", clientStaticFiles(directory));
		app.get("/watch/*", (_req, res) => {
			setNoStoreHeaders(res);
			res.type("html").send("<html>SPA entry</html>");
		});
	});
	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it.each([
		"assets/player-Ab12_cD3.js",
		"assets/styles-ABc123_4.css",
	])("allows immutable caching for hashed asset %s even under a base URL", async file => {
		const response = await request(app).get(`/watch/${file}`).expect(200);
		expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
		expect(response.headers.pragma).toBeUndefined();
	});

	it.each([
		"index.html",
		"source-code.tar.gz",
		"favicon.ico",
		"assets/runtime.js",
		"outside-Ab12_cD3.js",
		"room/test-room",
		"",
	])("prevents stale caching for entry, unversioned file, or SPA route %s", async file => {
		const response = await request(app).get(`/watch/${file}`).expect(200);
		expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
		expect(response.headers.pragma).toBe("no-cache");
		expect(response.headers.expires).toBe("0");
	});

	it("returns changed entry HTML to a client that presents the previous validator", async () => {
		const previous = await request(app).get("/watch/index.html").expect(200);
		await writeFile(
			join(directory, "index.html"),
			"<html>new deployment and fresh assets</html>",
		);
		const current = await request(app)
			.get("/watch/index.html")
			.set("If-None-Match", previous.headers.etag)
			.expect(200);
		expect(current.text).toContain("new deployment and fresh assets");
		expect(current.headers["cache-control"]).toBe("no-store, max-age=0");
	});
});
