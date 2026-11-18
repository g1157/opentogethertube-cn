import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import DashVideoAdapter from "../../../services/dash.js";

describe("DASH manifest request boundaries", () => {
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

	async function serve(body: string, end = true): Promise<string> {
		server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/dash+xml" });
			if (end) {
				response.end(body);
			} else {
				response.write(body);
				// Continuous bytes keep the socket active; only a total deadline can stop this.
				const timer = setInterval(() => response.write(" "), 50);
				response.once("close", () => clearInterval(timer));
			}
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}/video.mpd`;
	}

	it("rejects an oversized MPD before building an XML document", async () => {
		const url = await serve(
			`<MPD mediaPresentationDuration="PT60S"><!--${"x".repeat(3 * 1024 * 1024)}--></MPD>`,
		);
		await expect(new DashVideoAdapter().fetchVideoInfo(url)).rejects.toThrow();
	});

	it("cancels a manifest response that never finishes", async () => {
		const url = await serve('<MPD mediaPresentationDuration="PT60S">', false);
		await expect(new DashVideoAdapter().fetchVideoInfo(url)).rejects.toThrow();
	}, 8000);

	it("rejects malformed XML without repairing it into a video", async () => {
		const url = await serve('<MPD mediaPresentationDuration="PT60S"><Period></MPD>');
		await expect(new DashVideoAdapter().fetchVideoInfo(url)).rejects.toThrow();
	});
});
