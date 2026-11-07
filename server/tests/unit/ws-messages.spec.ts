import { describe, expect, it } from "vitest";
import { RoomRequestType } from "ott-common/models/messages.js";
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
			{ action: "ping", t0: 1757900000000 },
			{
				action: "status",
				status: PlayerStatus.ready,
				playbackPrepared: { id: "preparation-1", position: 42.5 },
			},
			{
				action: "status",
				status: PlayerStatus.buffering,
				diagnostics: {
					sampledAt: 1_757_900_000_000,
					service: "hls",
					sourceHost: "media.example.test",
					playerKind: "native",
					hidden: false,
					paused: false,
					readyState: 3,
					networkState: 2,
					bufferAhead: 0.4,
					bufferGrowth: 0.2,
					startup: 12.5,
					rebuffers: 2,
					rebufferSeconds: 6,
					playSeconds: 120,
					rateWrites: 3,
					deadlineSeeks: 1,
					maxDrift: 4.2,
					totalFrames: 3000,
					droppedFrames: 12,
					wsRttMs: 35,
					connectionEffectiveType: "4g",
					connectionDownlinkMbps: 1.2,
					connectionRttMs: 180,
					connectionSaveData: false,
					hlsBandwidthKbps: 1800,
					hlsLevelHeight: 720,
					hlsLevelCount: 3,
					autoplayBlocked: false,
					recovering: false,
					seeking: false,
					errorCode: null,
				},
			},
			{
				action: "diagnostics",
				diagnostics: {
					sampledAt: 1_757_900_000_000,
					bufferAhead: 0.2,
					bufferGrowth: 0.1,
					hidden: false,
					readyState: 2,
				},
			},
			// The client sends numeric RoomRequestType values on the wire.
			{ action: "req", request: { type: RoomRequestType.JoinRequest } },
			{
				action: "req",
				request: { type: RoomRequestType.PlaybackRequest, state: true },
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
			{
				action: "status",
				status: PlayerStatus.ready,
				diagnostics: { bufferAhead: 1 },
			},
			{
				action: "status",
				status: PlayerStatus.ready,
				diagnostics: { sampledAt: 1, bufferAhead: -1 },
			},
			{
				action: "status",
				status: PlayerStatus.ready,
				diagnostics: { sampledAt: 1, sourceHost: "x".repeat(256) },
			},
			{ action: "diagnostics" },
			{ action: "diagnostics", diagnostics: null },
			{ action: "diagnostics", diagnostics: {} },
			{ action: "notify", message: "somethingElse" },
			{ action: "req" },
			{ action: "req", request: { type: "play" } },
			{ action: "ping" },
			{ action: "ping", t0: "now" },
			{ action: "ping", t0: Number.POSITIVE_INFINITY },
			{ action: "unknown" },
			{},
		];
		for (const message of rejected) {
			const result = clientMessageSchema.safeParse(message);
			expect(result.success, JSON.stringify(message)).toBe(false);
		}
	});
});
