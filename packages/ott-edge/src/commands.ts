import { z } from "zod";
import { RoomRequestType as R } from "ott-common/models/messages.js";
import { RoomSettingsSchema } from "ott-common/models/zod-schemas.js";
import { Role } from "ott-common/models/types.js";

const finitePosition = z
	.number()
	.finite()
	.min(0)
	.max(31 * 86400);
export const videoId = z.object({
	service: z.enum(["direct", "hls", "dash"]),
	id: z.string().min(1).max(4096),
});
export const videoAdd = videoId.extend({
	startAt: finitePosition.optional(),
	endAt: finitePosition.optional(),
	subtitleUrl: z.union([z.string().url().max(4096), z.literal("")]).optional(),
});
const settings = RoomSettingsSchema.extend({
	description: z.string().max(2000).optional(),
	grants: z
		.array(z.tuple([z.nativeEnum(Role), z.number().int().min(0).max(0x7fffffff)]))
		.max(6)
		.optional(),
});

export const commandSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal(R.PlaybackRequest), state: z.boolean() }),
	z.object({ type: z.literal(R.SkipRequest) }),
	z.object({ type: z.literal(R.SeekRequest), value: finitePosition }),
	z.object({
		type: z.literal(R.AddRequest),
		video: videoAdd.optional(),
		videos: z.array(videoAdd).min(1).max(10).optional(),
		url: z.string().max(4096).optional(),
	}),
	z.object({ type: z.literal(R.RemoveRequest), video: videoId }),
	z.object({
		type: z.literal(R.OrderRequest),
		fromIdx: z.number().int().min(0),
		toIdx: z.number().int().min(0),
	}),
	z.object({ type: z.literal(R.VoteRequest), video: videoId, add: z.boolean() }),
	z.object({
		type: z.literal(R.PromoteRequest),
		targetClientId: z.string().max(128),
		role: z.nativeEnum(Role),
	}),
	z.object({ type: z.literal(R.ChatRequest), text: z.string().trim().min(1).max(1000) }),
	z.object({ type: z.literal(R.ApplySettingsRequest), settings }),
	z.object({ type: z.literal(R.PlayNowRequest), video: videoAdd }),
	z.object({ type: z.literal(R.ShuffleRequest) }),
	z.object({
		type: z.literal(R.PlaybackSpeedRequest),
		speed: z.number().finite().min(0.25).max(4),
	}),
	z.object({ type: z.literal(R.RestoreQueueRequest), discard: z.boolean().optional() }),
	z.object({ type: z.literal(R.KickRequest), clientId: z.string().max(128) }),
	z.object({
		type: z.literal(R.UpdateQueueItemRequest),
		video: videoId,
		update: videoAdd.omit({ id: true, service: true }),
	}),
	z.object({
		type: z.literal(R.TemporaryPlaybackSpeedRequest),
		action: z.enum(["start", "renew", "stop"]),
		gestureId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
		video: videoId,
	}),
]);
export type Command = z.infer<typeof commandSchema>;

export const commandPermissions: Partial<Record<R, string>> = {
	[R.PlaybackRequest]: "playback.play-pause",
	[R.SkipRequest]: "playback.skip",
	[R.SeekRequest]: "playback.seek",
	[R.AddRequest]: "manage-queue.add",
	[R.RemoveRequest]: "manage-queue.remove",
	[R.OrderRequest]: "manage-queue.order",
	[R.VoteRequest]: "manage-queue.vote",
	[R.ChatRequest]: "chat",
	[R.PlayNowRequest]: "manage-queue.play-now",
	[R.ShuffleRequest]: "manage-queue.order",
	[R.PlaybackSpeedRequest]: "playback.speed",
	[R.RestoreQueueRequest]: "manage-queue.add",
	[R.KickRequest]: "manage-users.kick",
	[R.UpdateQueueItemRequest]: "manage-queue.edit",
	[R.TemporaryPlaybackSpeedRequest]: "playback.speed",
};
