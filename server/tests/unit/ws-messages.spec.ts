import { describe, expect, it } from "vitest";
import { PlayerStatus } from "ott-common/models/types.js";
import { clientMessageSchema } from "../../ws-schemas.js";

// Mirrors how the server generates auth tokens: base64 of 512 random bytes.
const realisticToken = Buffer.alloc(512, 7).toString("base64");

describe("inbound websocket messages", () => {
	it("accepts the payloads the client actually sends", () => {
		const messages: unknown[] = [
			{ action: "auth", token: realisticToken },
			{ action: "kickme" },
			{ action: "kickme", reason: 1000 },
			{ action: "notify", message: "usernameChanged" },
			{ action: "status", status: PlayerStatus.ready },
			{
				action: "status",
				status: PlayerStatus.ready,
				playbackPrepared: { id: "preparation-1", position: 42.5 },
			},
			{ action: "req", request: { type: "join" } },
			{
				action: "req",
				request: {
					type: "play",
					video: { service: "direct", id: "https://example.com/a.mp4" },
				},
			},
		];
		expect(realisticToken).toHaveLength(684);
		for (const message of messages) {
			const result = clientMessageSchema.safeParse(message);
			expect(result.success, JSON.stringify(message)).toBe(true);
		}
	});

	it("rejects malformed or unknown messages", () => {
		const rejected: unknown[] = [
			{ action: "auth" },
			{ action: "auth", token: 42 },
			{ action: "auth", token: "x".repeat(2048) },
			{ action: "status", status: "wat" },
			{ action: "notify", message: "somethingElse" },
			{ action: "req" },
			{ action: "unknown" },
			{},
		];
		for (const message of rejected) {
			const result = clientMessageSchema.safeParse(message);
			expect(result.success, JSON.stringify(message)).toBe(false);
		}
	});
});
