import { z } from "zod";
import { PlayerStatus } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { ALL_VIDEO_SERVICES } from "ott-common/constants.js";

// Auth tokens are base64 of 512 random bytes (684 characters). A cap below that kicks
// every client out of its room on connect.
const AUTH_TOKEN_MAX_LENGTH = 1024;

const playbackPreparedSchema = z.object({
	id: z.string().max(100),
	position: z.number().finite(),
	bufferAhead: z
		.number()
		.finite()
		.min(0)
		.max(24 * 60 * 60)
		.nullish(),
	firstFrame: z.boolean().optional(),
	playerKind: z.enum(["native", "embedded"]).optional(),
	visible: z.boolean().optional(),
	failed: z.boolean().optional(),
	reason: z.string().max(200).optional(),
});

/**
 * Bounded explicitly: every value is logged when a viewer holds the buffer gate, so a
 * crafted client must not be able to inject a huge string or a nonsensical number.
 * `receivedAt` is deliberately absent: the server stamps it locally.
 */
const playbackDiagnosticsSchema = z.object({
	sampledAt: z.number().finite().min(0),
	service: z.string().max(32).optional(),
	sourceHost: z.string().max(255).optional(),
	playerKind: z.enum(["native", "embedded"]).optional(),
	hidden: z.boolean().optional(),
	paused: z.boolean().optional(),
	readyState: z.number().int().min(0).max(4).optional(),
	networkState: z.number().int().min(0).max(3).optional(),
	bufferAhead: z
		.number()
		.finite()
		.min(0)
		.max(24 * 60 * 60)
		.nullish(),
	bufferGrowth: z.number().finite().min(-100).max(100).nullish(),
	startup: z
		.number()
		.finite()
		.min(0)
		.max(24 * 60 * 60)
		.nullish(),
	rebuffers: z.number().int().min(0).max(1_000_000).optional(),
	rebufferSeconds: z
		.number()
		.finite()
		.min(0)
		.max(24 * 60 * 60)
		.optional(),
	playSeconds: z
		.number()
		.finite()
		.min(0)
		.max(7 * 24 * 60 * 60)
		.optional(),
	rateWrites: z.number().int().min(0).max(1_000_000).optional(),
	deadlineSeeks: z.number().int().min(0).max(1_000_000).optional(),
	maxDrift: z
		.number()
		.finite()
		.min(0)
		.max(24 * 60 * 60)
		.optional(),
	totalFrames: z.number().int().min(0).max(1_000_000_000_000).optional(),
	droppedFrames: z.number().int().min(0).max(1_000_000_000_000).optional(),
	wsRttMs: z.number().finite().min(0).max(60_000).nullish(),
	connectionEffectiveType: z.string().max(16).optional(),
	connectionDownlinkMbps: z.number().finite().min(0).max(10_000).optional(),
	connectionRttMs: z.number().finite().min(0).max(60_000).optional(),
	connectionSaveData: z.boolean().optional(),
	hlsBandwidthKbps: z.number().finite().min(0).max(1_000_000).optional(),
	hlsLevelHeight: z.number().int().min(0).max(10_000).optional(),
	hlsLevelCount: z.number().int().min(0).max(1000).optional(),
	autoplayBlocked: z.boolean().optional(),
	recovering: z.boolean().optional(),
	seeking: z.boolean().optional(),
	errorCode: z.number().int().min(0).max(4).nullish(),
});

export const clientMessageSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("auth"),
		token: z.string().max(AUTH_TOKEN_MAX_LENGTH),
	}),
	// Re-authentication on an open socket: the identity behind the connection changed
	// (a login rotates the token), but the viewer stays in the room.
	z.object({
		action: z.literal("reauthenticate"),
		token: z.string().max(AUTH_TOKEN_MAX_LENGTH),
	}),
	z.object({
		action: z.literal("kickme"),
		reason: z.number().optional(),
	}),
	z.object({
		action: z.literal("status"),
		status: z.nativeEnum(PlayerStatus),
		playbackPrepared: playbackPreparedSchema.optional(),
		diagnostics: playbackDiagnosticsSchema.optional(),
	}),
	z.object({
		action: z.literal("diagnostics"),
		diagnostics: playbackDiagnosticsSchema,
	}),
	z.object({
		action: z.literal("notify"),
		message: z.literal("usernameChanged"),
	}),
	// Signaling is relayed verbatim to one other client in the same room. Length caps keep a
	// single participant from using the relay as a general-purpose message bus.
	z.object({
		action: z.literal("signal"),
		to: z.string().min(1).max(64),
		signal: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("offer"), sdp: z.string().max(16384) }),
			z.object({ kind: z.literal("answer"), sdp: z.string().max(16384) }),
			z.object({
				kind: z.literal("candidate"),
				candidate: z.object({
					candidate: z.string().max(1024),
					sdpMid: z.string().max(64).nullish(),
					sdpMLineIndex: z.number().int().min(0).max(1024).nullish(),
					usernameFragment: z.string().max(256).nullish(),
				}),
			}),
		]),
	}),
	z.object({
		action: z.literal("voice"),
		joined: z.boolean(),
	}),
	// Latency probe; the server echoes t0 back so the client can estimate the round trip.
	z.object({
		action: z.literal("ping"),
		t0: z.number().finite(),
	}),
	// Room requests are validated per command inside the room; the envelope guards size and shape.
	// RoomRequestType values are numeric enum members on the wire (e.g. PlaybackRequest = 2).
	z.object({
		action: z.literal("req"),
		request: z.object({ type: z.number().int().min(0).max(999) }).passthrough(),
	}),
]);

const undoEventVideoSchema = z
	.object({
		service: z.enum(ALL_VIDEO_SERVICES),
		id: z.string().min(1).max(2048),
	})
	.passthrough();

// Undo events echo a room event back to the server, and the room applies the fields below
// without further checks; shape them here so a forged event cannot inject state (an
// unknown request type, a non-finite position, or a video outside the known services).
export const undoEventSchema = z
	.object({
		request: z
			.object({
				type: z.union([
					z.literal(RoomRequestType.SeekRequest),
					z.literal(RoomRequestType.SkipRequest),
					z.literal(RoomRequestType.AddRequest),
					z.literal(RoomRequestType.RemoveRequest),
				]),
				video: undoEventVideoSchema.optional(),
			})
			.passthrough(),
		additional: z
			.object({
				video: undoEventVideoSchema.optional(),
				prevPosition: z.number().finite().min(0).optional(),
				queueIdx: z.number().int().min(0).optional(),
			})
			.passthrough(),
	})
	.passthrough();
