import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { fetchPublicJson, MAX_METADATA_BYTES } from "../../../services/parsing/json-fetch.js";

const TOO_LARGE = /maxContentLength/;
const REDIRECT_REJECTED = /302/;
const DEADLINE_REACHED = /canceled|timeout/i;
const oversized = JSON.stringify({ text: "x".repeat(MAX_METADATA_BYTES) });
const paths: string[] = [];
let origin: string;

// These real loopback HTTP tests exercise byte/deadline/redirect behavior, not the DNS guard.
// Production/private-address rejection is tested separately in adapters-network-boundaries.
const server = http.createServer((request, response) => {
	paths.push(request.url ?? "");
	response.setHeader("Content-Type", "application/json");
	if (request.url === "/redirect") {
		response.writeHead(302, { Location: "/ok" });
		response.end();
	} else if (request.url === "/oversized") {
		response.end(oversized);
	} else if (request.url === "/compressed") {
		response.setHeader("Content-Encoding", "gzip");
		response.end(gzipSync(oversized));
	} else if (request.url === "/chunked") {
		response.write(" ");
		response.end(oversized);
	} else if (request.url === "/slow") {
		response.write('{"text":"');
		const timer = setInterval(() => response.write("x"), 50);
		response.on("close", () => clearInterval(timer));
	} else {
		response.end(JSON.stringify({ text: "utf8-\u4e2d" }));
	}
});

describe("metadata fetch real HTTP resource boundaries", () => {
	beforeAll(async () => {
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
	});

	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "test");
		paths.length = 0;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close(error => (error ? reject(error) : resolve())),
		);
	});

	it("decodes a normal bounded JSON response", async () => {
		expect((await fetchPublicJson(origin + "/ok")).data).toEqual({ text: "utf8-\u4e2d" });
	});

	it.each([
		"oversized",
		"chunked",
		"compressed",
	])("bounds decoded bytes for %s responses", async path => {
		await expect(fetchPublicJson(origin + "/" + path)).rejects.toThrow(TOO_LARGE);
	});

	it("does not follow an implicit redirect to a different URL", async () => {
		await expect(fetchPublicJson(origin + "/redirect")).rejects.toThrow(REDIRECT_REJECTED);
		expect(paths).toEqual(["/redirect"]);
	});

	it("aborts a stream that continuously sends bytes rather than relying only on idle timeout", async () => {
		const start = performance.now();
		await expect(fetchPublicJson(origin + "/slow")).rejects.toThrow(DEADLINE_REACHED);
		expect(performance.now() - start).toBeLessThan(8000);
	}, 12000);
});
