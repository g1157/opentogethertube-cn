import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import DirectVideoAdapter from "../../../services/direct.js";

describe("custom media manifest metadata", () => {
	let server: Server | undefined;
	afterEach(async () => {
		if (server) {
			const closed = once(server, "close");
			server.close();
			server.closeAllConnections();
			await closed;
			server = undefined;
		}
	});

	async function serve(manifest: Record<string, unknown>): Promise<string> {
		server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					title: "Review fixture",
					sources: [
						{
							url: "https://media.example.com/video.mp4",
							contentType: "video/mp4",
							quality: 720,
						},
					],
					...manifest,
				}),
			);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}/media.json`;
	}

	it("keeps live manifests out of the VOD clock and preparation round", async () => {
		const url = await serve({ live: true, duration: 0 });
		const video = await new DirectVideoAdapter().fetchVideoInfo(url);
		expect(video.isLive).toBe(true);
		expect(video.length).toBeUndefined();
	});

	it("keeps rounded VOD duration metadata", async () => {
		const url = await serve({ duration: 60.2 });
		const video = await new DirectVideoAdapter().fetchVideoInfo(url);
		expect(video.length).toBe(61);
		expect(video.isLive).toBeUndefined();
	});

	it("rejects an oversized manifest body instead of allocating the entire response", async () => {
		const url = await serve({ duration: 60, padding: "x".repeat(3 * 1024 * 1024) });
		await expect(new DirectVideoAdapter().fetchVideoInfo(url)).rejects.toThrow();
	});
});
