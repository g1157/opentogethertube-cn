import { z } from "zod";
import { PlayerStatus } from "ott-common/models/types.js";

// Auth tokens are base64 of 512 random bytes (684 characters). A cap below that kicks
// every client out of its room on connect.
const AUTH_TOKEN_MAX_LENGTH = 1024;

const playbackPreparedSchema = z.object({
	id: z.string().max(100),
	position: z.number().finite(),
});

export const clientMessageSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("auth"),
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
	// Room requests are validated per command inside the room; the envelope guards size and shape.
	// RoomRequestType values are numeric enum members on the wire (e.g. PlaybackRequest = 2).
	z.object({
		action: z.literal("req"),
		request: z.object({ type: z.number().int().min(0).max(999) }).passthrough(),
	}),
]);
