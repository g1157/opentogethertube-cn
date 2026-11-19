import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room } from "../../room.js";
import { buildClients } from "../../redisclient.js";
import { loadModels } from "../../models/index.js";
import { getManyVideoInfo } from "../../storage/cachedvideo.js";
import { mergeVideo } from "../../infoextractor.js";
import { Role } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";

/**
 * Pins defects found by tracing the room state machine and the media pipeline. Each one
 * changed behaviour quietly instead of throwing, so none of them were caught by a test.
 */
describe("room and media pipeline regressions", () => {
	let room: Room;
	beforeAll(async () => {
		loadModels();
		await buildClients();
	});
	beforeEach(() => {
		room = new Room({
			name: `regress-${Math.random().toString(36).slice(2, 8)}`,
			isTemporary: true,
		});
		room.throttledSync.cancel();
		vi.spyOn(room, "throttledSync").mockReturnValue(undefined);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
	});

	/**
	 * A room rebuilt from storage hands its first item over paused on purpose, and only
	 * play() cleared that marker. playNow on a native source goes through the prepared
	 * start instead, so the marker survived: the following dequeue froze the clock while
	 * isPlaying stayed true and the room never advanced to the next episode.
	 */
	it("clears the storage-restored hold when a prepared start begins", async () => {
		room.restoreFromStorage();
		expect(room["restoredFromStorage"]).toBe(true);

		room.currentSource = { service: "direct", id: "https://example.com/a.mp4" };
		room.playbackPosition = 12;
		// A single eligible viewer starts synchronously, which is what playNow reaches.
		room["playbackPreparation"] = {
			id: "prep-1",
			clientId: "viewer-1",
			video: { service: "direct", id: "https://example.com/a.mp4" },
			position: 12,
			eligible: ["viewer-1"],
			ready: [],
			deadlineAt: Date.now() + 8000,
			hardDeadlineAt: Date.now() + 20000,
			startAt: Date.now(),
			fallback: null,
		};
		await room["startPreparedPlayback"]();

		expect(room.isPlaying).toBe(true);
		expect(room["restoredFromStorage"]).toBe(false);
	});

	/**
	 * A batch add records `additional.videos` and carries no `request.video`, so the old
	 * undo branch skipped every added item and cleared whatever was playing instead.
	 */
	it("undoes a batch add by removing the items it queued", async () => {
		const context = { username: "owner", role: Role.Owner, clientId: "owner-client" };
		const videos = [
			{ service: "youtube" as const, id: "batch-a" },
			{ service: "youtube" as const, id: "batch-b" },
		];
		// Enqueue directly: fetching metadata for invented ids is not part of this check.
		await room.queue.enqueue(...videos);
		room.currentSource = { service: "youtube", id: "currently-playing" };
		room["recentEvents"].push({
			request: { type: RoomRequestType.AddRequest, videos },
			additional: { videos },
			user: {
				id: "owner-client",
				name: "owner",
				isLoggedIn: false,
				status: 0,
				role: Role.Owner,
			},
		} as never);

		const recorded = room["recentEvents"].at(-1)!;
		await room.undo({ type: RoomRequestType.UndoRequest, event: recorded } as never, context);

		expect(room.queue.length).toBe(0);
		expect(room.currentSource).toEqual({ service: "youtube", id: "currently-playing" });
	});

	/**
	 * A status/diagnostics heartbeat arrives every few seconds per viewer, but RoomUserInfo
	 * carries neither of those fields. Broadcasting the whole member on every heartbeat was
	 * n²/5 messages per second in an n-viewer room.
	 */
	it("does not broadcast for a heartbeat that changes nothing visible", async () => {
		const context = (id: string) => ({
			clientId: id,
			username: id,
			role: Role.Owner,
			auth: { token: `test-${id}`, clientId: id },
		});
		await room.joinRoom(
			{ type: RoomRequestType.JoinRequest, info: { id: "viewer-1", username: "viewer-1" } },
			context("viewer-1"),
		);
		vi.spyOn(room, "syncUser").mockResolvedValue(undefined);
		vi.mocked(room.syncUser).mockClear();

		await room.updateUser(
			{
				type: RoomRequestType.UpdateUser,
				info: { id: "viewer-1", diagnostics: { bufferAhead: 3 } },
			} as never,
			context("viewer-1"),
		);
		expect(room.syncUser).not.toHaveBeenCalled();

		// A rename is visible to everyone and must still be announced.
		await room.updateUser(
			{
				type: RoomRequestType.UpdateUser,
				info: { id: "viewer-1", username: "renamed" },
			} as never,
			context("viewer-1"),
		);
		expect(room.syncUser).toHaveBeenCalledTimes(1);
	});

	/**
	 * `mergeVideo` filtered with `!!x`, which dropped `false` along with null/undefined, so
	 * a probe that established `cors: false` never reached the client.
	 */
	it("keeps a probe's cors:false instead of merging it away", () => {
		const merged = mergeVideo(
			{ service: "direct", id: "https://example.com/a.mp4" } as never,
			{ service: "direct", id: "https://example.com/a.mp4", cors: false } as never,
		);
		expect(merged.cors).toBe(false);
	});

	/**
	 * A cache miss pushed the caller's own object into the result, and filterVideoInfo then
	 * read its title/thumbnail/length as database columns. Any viewer allowed to add a
	 * video could plant metadata for every room on the server.
	 */
	it("returns only the identity for a video that is not cached", async () => {
		const planted = {
			service: "youtube",
			id: "not-cached-" + Math.random().toString(36).slice(2, 8),
			title: "planted title",
			thumbnail: "https://evil.example.com/x.webp",
			length: 999999,
		};
		const [result] = await getManyVideoInfo([planted]);
		expect(result).toEqual({ service: planted.service, id: planted.id });
		expect(result.title).toBeUndefined();
		expect(result.thumbnail).toBeUndefined();
		expect(result.length).toBeUndefined();
	});
});
