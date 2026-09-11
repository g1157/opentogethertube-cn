import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import DirectVideoAdapter from "../../services/direct.js";
import { isPrivateAddress } from "../../ffprobe.js";

const RANGE = /^bytes=(\d+)-(\d*)$/;
let server: Server | undefined;

describe("media URL address guard", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::",
		"fd00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
		"not-an-ip",
	])("rejects %s", address => {
		expect(isPrivateAddress(address)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"172.32.0.1",
		"2606:4700:4700::1111",
		"::ffff:8.8.8.8",
	])("accepts %s", address => {
		expect(isPrivateAddress(address)).toBe(false);
	});
});

describe("direct media probing", () => {
	afterEach(async () => {
		if (server) {
			const closed = once(server, "close");
			server.close();
			server.closeAllConnections();
			await closed;
			server = undefined;
		}
	});

	it("seeks to a tail MP4 index instead of downloading the intervening video", async () => {
		const fixture = await readFile(
			new URL("../../../tests/assets/Big_Buck_Bunny_360_10s_1MB.mp4", import.meta.url),
		);
		// Keep sample offsets unchanged, replace the leading moov with free space,
		// and move the index behind a virtual 32 MiB mdat. Only small ranges are sent.
		const indexSize = fixture.readUInt32BE(32);
		const index = fixture.subarray(32, 32 + indexSize);
		const prefix = Buffer.from(fixture);
		prefix.write("free", 36);
		const mdatOffset = 32 + indexSize + 8;
		prefix.writeUInt32BE(32 * 1024 * 1024, mdatOffset);
		const indexOffset = mdatOffset + 32 * 1024 * 1024;
		const total = indexOffset + index.byteLength;
		const starts: number[] = [];
		let downloaded = 0;
		server = createServer((request, response) => {
			const range = RANGE.exec(request.headers.range ?? "");
			const start = range ? Number(range[1]) : 0;
			const end = range?.[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
			starts.push(start);
			response.writeHead(range ? 206 : 200, {
				"Content-Type": "video/mp4",
				"Content-Length": end - start + 1,
				"Accept-Ranges": "bytes",
				...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			let offset = start;
			const send = () => {
				if (response.destroyed) {
					return;
				}
				if (offset > end) {
					response.end();
					return;
				}
				if (downloaded >= 2 * 1024 * 1024) {
					response.destroy(
						new Error("Probe downloaded the video body instead of seeking"),
					);
					return;
				}
				const data = Buffer.alloc(Math.min(16 * 1024, end - offset + 1));
				if (offset < prefix.byteLength) {
					prefix.copy(
						data,
						0,
						offset,
						Math.min(offset + data.byteLength, prefix.byteLength),
					);
				}
				if (offset + data.byteLength > indexOffset) {
					index.copy(
						data,
						Math.max(0, indexOffset - offset),
						Math.max(0, offset - indexOffset),
					);
				}
				downloaded += data.byteLength;
				offset += data.byteLength;
				response.write(data);
				setTimeout(send, 2);
			};
			send();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as AddressInfo).port;
		const video = await new DirectVideoAdapter().fetchVideoInfo(
			`http://127.0.0.1:${port}/tail.mp4`,
		);
		expect(video).toMatchObject({ length: 10, mime: "video/mp4" });
		expect(starts.some(start => start >= indexOffset)).toBe(true);
		expect(downloaded).toBeLessThan(2 * 1024 * 1024);
	}, 10000);
});
