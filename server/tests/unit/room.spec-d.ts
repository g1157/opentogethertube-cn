/* eslint-disable vitest/expect-expect */
import { describe, it, expectTypeOf } from "vitest";
import type { ServerMessageSync } from "ott-common/models/messages.js";
import type { RoomStateSyncable } from "../../room.js";
import type { ConvertToJsonSafe } from "ott-common/serialize.js";

describe("room state types", () => {
	it("should always keep RoomStateSyncable and ServerMessageSync in sync", () => {
		type B =
			| "name"
			| "title"
			| "description"
			| "isTemporary"
			| "visibility"
			| "queueMode"
			| "currentSource"
			| "queue"
			| "isPlaying"
			| "playbackPosition"
			| "playbackSpeed"
			| "temporaryPlaybackSpeed"
			| "grants"
			| "hasOwner"
			| "voteCounts"
			| "videoSegments"
			| "autoSkipSegmentCategories"
			| "prevQueue"
			| "restoreQueueBehavior"
			| "enableVoteSkip"
			| "votesToSkip";
		type ExMsg = Pick<ServerMessageSync, B>;
		type ExRoom = Pick<Partial<ConvertToJsonSafe<RoomStateSyncable>>, B>;
		expectTypeOf<ExMsg>().toEqualTypeOf<ExRoom>();

		// `serverTime` is not room state: it is the instant the carried position was sampled,
		// so a client can anchor it at the server's clock instead of at its arrival.
		expectTypeOf<Omit<ServerMessageSync, "action" | "serverTime">>().toEqualTypeOf<
			Partial<ConvertToJsonSafe<RoomStateSyncable>>
		>();
	});
});
