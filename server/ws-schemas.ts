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
	// Room requests are validated per command inside the room; the envelope guards size and shape.
	// RoomRequestType values are numeric enum members on the wire (e.g. PlaybackRequest = 2).
	z.object({
		action: z.literal("req"),
		request: z.object({ type: z.number().int().min(0).max(999) }).passthrough(),
	}),
]);
