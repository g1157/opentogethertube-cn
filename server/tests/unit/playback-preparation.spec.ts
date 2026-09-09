import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerStatus, Role } from "ott-common/models/types.js";
import {
	RoomRequestType,
	type PlaybackPrepared,
	type RoomRequestContext,
} from "ott-common/models/messages.js";
import { Room, type RoomStateFromRedis } from "../../room.js";
import roommanager, { redisStateToState, update as updateRooms } from "../../roommanager.js";
import { buildClients, redisClient } from "../../redisclient.js";
import { conf } from "../../ott-config.js";
import storage from "../../storage.js";

describe("preparing playback after a room was empty", () => {
	let room: Room;
	const allRooms: Room[] = [];
	const video = { service: "direct" as const, id: "episode-03.mp4", length: 600 };
	const context = (id: string): RoomRequestContext => ({
		clientId: id,
		username: id,
		role: Role.UnregisteredUser,
		auth: { token: `test-${id}`, clientId: id },
	});
	const join = (id: string, target = room) =>
		target.joinRoom(
			{ type: RoomRequestType.JoinRequest, info: { id, username: id } },
			context(id),
		);
	const leave = (id: string, target = room) =>
		target.leaveRoom({ type: RoomRequestType.LeaveRequest }, context(id));
	const report = (
		id: string,
		prepared?: PlaybackPrepared,
		status = PlayerStatus.ready,
		target = room,
	) =>
		target.updateUser(
			{
				type: RoomRequestType.UpdateUser,
				info: { id, status },
				playbackPrepared: prepared,
			},
			context(id),
		);
	const advanceTime = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

	beforeAll(async () => {
		await buildClients();
		conf.set("video.sponsorblock.enabled", false);
	});
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-09T08:00:00Z"));
		vi.spyOn(storage, "updateRoom").mockResolvedValue(true);
		room = new Room({ name: "prepare-empty-room", isTemporary: true });
		allRooms.push(room);
		room.currentSource = video;
		room.playbackPosition = 120;
		room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.play-pause", "playback.seek"]);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});
	afterEach(() => {
		roommanager.clearRooms();
		for (const item of allRooms.splice(0)) {
			item.throttledSync.cancel();
			item.saveStateToRedisDebounced.cancel();
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function watchThenLeave() {
		await join("previous");
		await room.play();
		advanceTime(5);
		await leave("previous");
	}

	it.each([
		false,
		true,
	])("freezes the last watched position when the final viewer leaves (temporary=%s)", async isTemporary => {
		room.isTemporary = isTemporary;
		await watchThenLeave();
		expect(room.realPlaybackPosition).toBe(125);
		expect(room.isPlaying).toBe(false);
		expect(room.resumeOnNextJoin).toBe(true);
		advanceTime(120);
		await room.update();
		expect(room.realPlaybackPosition).toBe(125);
		expect(room.currentSource).toEqual(video);
	});

	it("waits for actual local playback at the saved position before starting the room clock", async () => {
		await watchThenLeave();
		await join("first");
		const preparation = room.playbackPreparation!;
		expect(preparation).toMatchObject({
			clientId: "first",
			video: { service: video.service, id: video.id },
			position: 125,
		});
		expect(room.syncableState()).toMatchObject({
			isPlaying: false,
			playbackPosition: 125,
			playbackPreparation: preparation,
		});
		advanceTime(8);
		await report("first"); // Existing canplay/ready reports are not proof of rendered playback.
		expect(room.isPlaying).toBe(false);
		expect(room.realPlaybackPosition).toBe(125);
		await report("first", { id: preparation.id, position: 125.1 });
		expect(room.isPlaying).toBe(true);
		expect(room.playbackPreparation).toBeNull();
		expect(room.resumeOnNextJoin).toBe(false);
		expect(room.realPlaybackPosition).toBe(125);
		advanceTime(2.5);
		expect(room.realPlaybackPosition).toBe(127.5);
		await room.sync();
		expect(room.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "sync",
				isPlaying: true,
				playbackPreparation: null,
				playbackPosition: 127.5,
			}),
		);
	});

	it("keeps one preparer when viewers join nearly together and rejects another viewer's acknowledgement", async () => {
		await watchThenLeave();
		await Promise.all([join("first"), join("second")]);
		const preparation = room.playbackPreparation!;
		expect(preparation.clientId).toBe("first");
		await report("second", { id: preparation.id, position: 125 });
		expect(room.isPlaying).toBe(false);
		await report("first", { id: preparation.id, position: 125 });
		expect(room.isPlaying).toBe(true);
	});

	it("hands preparation to the next viewer if the first disconnects, invalidating the previous token", async () => {
		await watchThenLeave();
		await join("first");
		await join("second");
		const previous = room.playbackPreparation!;
		await report("second");
		await leave("first");
		const replacement = room.playbackPreparation!;
		expect(replacement.clientId).toBe("second");
		expect(replacement.id).not.toBe(previous.id);
		expect(replacement.position).toBe(125);
		await report("second", { id: previous.id, position: 125 });
		expect(room.isPlaying).toBe(false);
		await report("second", { id: replacement.id, position: 125 });
		expect(room.isPlaying).toBe(true);
	});

	it("keeps the saved position if the only preparing viewer disconnects and rejoins", async () => {
		await watchThenLeave();
		await join("old-connection");
		const previous = room.playbackPreparation!;
		advanceTime(6);
		await leave("old-connection");
		advanceTime(30);
		await join("new-connection");
		expect(room.playbackPreparation?.id).not.toBe(previous.id);
		expect(room.playbackPreparation).toMatchObject({
			clientId: "new-connection",
			position: 125,
		});
		expect(room.realPlaybackPosition).toBe(125);
	});

	it("does not pause viewers who are already watching when someone joins or leaves", async () => {
		await join("watching");
		await room.play();
		advanceTime(10);
		await join("newcomer");
		await report("newcomer", { id: "invented", position: 130 });
		expect(room.playbackPreparation).toBeNull();
		expect(room.isPlaying).toBe(true);
		await leave("newcomer");
		advanceTime(5);
		expect(room.realPlaybackPosition).toBe(135);
		expect(room.isPlaying).toBe(true);
	});

	it("holds a previously running empty-room snapshot before the first viewer starts loading", async () => {
		await room.play();
		advanceTime(5);
		await join("first");
		expect(room.isPlaying).toBe(false);
		expect(room.playbackPreparation).toMatchObject({ clientId: "first", position: 125 });
		advanceTime(10);
		expect(room.realPlaybackPosition).toBe(125);
	});

	it("respects an explicit pause during preparation and does not resume a room left paused", async () => {
		await watchThenLeave();
		await join("first");
		const previous = room.playbackPreparation!;
		await room.processRequest(
			{ type: RoomRequestType.PlaybackRequest, state: false },
			context("first"),
		);
		await report("first", { id: previous.id, position: 125 });
		expect(room.isPlaying).toBe(false);
		expect(room.playbackPreparation).toBeNull();
		await leave("first");
		await join("returning");
		expect(room.isPlaying).toBe(false);
		expect(room.playbackPreparation).toBeNull();
		expect(room.resumeOnNextJoin).toBe(false);
	});

	it("lets a permitted explicit Play override waiting, including for older clients", async () => {
		await watchThenLeave();
		await join("first");
		expect(room.playbackPreparation).not.toBeNull();
		await room.processRequest(
			{ type: RoomRequestType.PlaybackRequest, state: true },
			context("first"),
		);
		expect(room.playbackPreparation).toBeNull();
		expect(room.isPlaying).toBe(true);
	});

	it("invalidates a pending frame when an authorized viewer seeks", async () => {
		await watchThenLeave();
		await join("first");
		const previous = room.playbackPreparation!;
		await room.processRequest(
			{ type: RoomRequestType.SeekRequest, value: 180 },
			context("first"),
		);
		await report("first", { id: previous.id, position: 125 });
		expect(room.realPlaybackPosition).toBe(180);
		expect(room.isPlaying).toBe(false);
		expect(room.playbackPreparation).toBeNull();
	});

	it("invalidates a pending frame when the video is replaced, even if its replacement is later restored", async () => {
		await watchThenLeave();
		await join("first");
		const previous = room.playbackPreparation!;
		room.currentSource = { ...video, id: "episode-04.mp4" };
		room.currentSource = video;
		await report("first", { id: previous.id, position: 125 });
		expect(room.isPlaying).toBe(false);
		expect(room.playbackPreparation).toBeNull();
	});

	it("does not grant playback control through a readiness report after permissions are revoked", async () => {
		await watchThenLeave();
		await join("first");
		const previous = room.playbackPreparation!;
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		await report("first", { id: previous.id, position: 125 });
		expect(room.isPlaying).toBe(false);
		await room.update();
		expect(room.playbackPreparation).toBeNull();
		await expect(
			room.processRequest(
				{ type: RoomRequestType.PlaybackRequest, state: true },
				context("first"),
			),
		).rejects.toThrow();
	});

	it("does not automatically start for a first viewer without playback permission", async () => {
		await watchThenLeave();
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		await join("first");
		await report("first", { id: "invented", position: 125 });
		expect(room.playbackPreparation).toBeNull();
		expect(room.isPlaying).toBe(false);
	});

	it.each([
		undefined,
		null,
		{},
		{ id: "wrong", position: 125 },
		{ id: "current", position: Number.NaN },
		{ id: "current", position: Number.POSITIVE_INFINITY },
		{ id: "current", position: 0 },
		{ id: "current", position: 130 },
	])("ignores missing, stale, or nonmatching frame acknowledgements: %j", async value => {
		await watchThenLeave();
		await join("first");
		const current = room.playbackPreparation!;
		const prepared =
			value && "id" in value && value.id === "current" ? { ...value, id: current.id } : value;
		await report("first", prepared as PlaybackPrepared | undefined);
		expect(room.isPlaying).toBe(false);
		expect(room.realPlaybackPosition).toBe(125);
	});

	it.each([
		PlayerStatus.none,
		PlayerStatus.buffering,
		PlayerStatus.error,
	])("does not advance the clock while the preparing viewer reports %s", async status => {
		await watchThenLeave();
		await join("first");
		const preparation = room.playbackPreparation!;
		await report("first", { id: preparation.id, position: 125 }, status);
		advanceTime(12);
		expect(room.isPlaying).toBe(false);
		expect(room.realPlaybackPosition).toBe(125);
	});

	it("requires a nonnegative frame position when resuming at the start of a video", async () => {
		room.playbackPosition = 0;
		await join("previous");
		await room.play();
		await leave("previous");
		await join("first");
		const preparation = room.playbackPreparation!;
		await report("first", { id: preparation.id, position: -0.25 });
		expect(room.isPlaying).toBe(false);
		await report("first", { id: preparation.id, position: 0 });
		expect(room.isPlaying).toBe(true);
	});

	it("restores paused intent from Redis without reusing a disconnected viewer's preparation", async () => {
		room.isTemporary = false;
		await watchThenLeave();
		await join("before-restart");
		const previous = room.playbackPreparation!;
		await room.onBeforeUnload();
		const saved = JSON.parse(room.serializeState()) as RoomStateFromRedis;
		expect(saved).not.toHaveProperty("playbackPreparation");
		expect(saved.resumeOnNextJoin).toBe(true);
		expect(room.syncableState()).not.toHaveProperty("resumeOnNextJoin");
		advanceTime(60);
		const restored = new Room(redisStateToState(saved));
		allRooms.push(restored);
		vi.spyOn(restored, "publish").mockResolvedValue(undefined);
		await join("after-restart", restored);
		expect(restored.isPlaying).toBe(false);
		expect(restored.realPlaybackPosition).toBe(125);
		expect(restored.playbackPreparation?.clientId).toBe("after-restart");
		expect(restored.playbackPreparation?.id).not.toBe(previous.id);
	});

	it.each([
		false,
		true,
	])("reclaims an empty temporary room without renewing its snapshot (left during preparation=%s)", async leftDuringPreparation => {
		await watchThenLeave();
		// eslint-disable-next-line vitest/no-conditional-in-test -- Exercise both ways the final viewer can leave.
		if (leftDuringPreparation) {
			await join("preparing");
			await leave("preparing");
		}
		roommanager.rooms.push(room);
		expect(await redisClient.exists(`room:${room.name}`)).toBe(1);
		expect(room.playbackPreparation).toBeNull();
		expect(room.resumeOnNextJoin).toBe(true);
		const expiry = vi.spyOn(redisClient, "expire");
		const checkpoint = vi.spyOn(redisClient, "set");
		const lastActive = room._keepAlivePing.valueOf();
		const idleLimit = conf.get("room.unload_after");
		for (let elapsed = 0; elapsed < idleLimit; elapsed += 1) {
			advanceTime(1);
			await updateRooms();
		}
		expect(roommanager.rooms).toContain(room);
		expect(room._dirty.size).toBe(0);
		expect(room._keepAlivePing.valueOf()).toBe(lastActive);
		expect(expiry).not.toHaveBeenCalled();
		expect(checkpoint).not.toHaveBeenCalled();
		advanceTime(2);
		await updateRooms();
		expect(roommanager.rooms).not.toContain(room);
		expect(await redisClient.exists(`room:${room.name}`)).toBe(0);
		expect(await redisClient.exists(`room-sync:${room.name}`)).toBe(0);
		expect(storage.updateRoom).not.toHaveBeenCalled();
	});

	it("keeps an occupied preparing room alive, then allows normal eviction after that viewer leaves", async () => {
		await watchThenLeave();
		await join("preparing");
		const preparation = room.playbackPreparation!;
		roommanager.rooms.push(room);
		const expiry = vi.spyOn(redisClient, "expire");
		advanceTime(conf.get("room.unload_after") + 2);
		await updateRooms();
		expect(roommanager.rooms).toContain(room);
		expect(room.isStale).toBe(false);
		expect(room.playbackPreparation).toEqual(preparation);
		expect(expiry).toHaveBeenCalledWith(`room:${room.name}`, conf.get("room.expire_after"));
		await leave("preparing");
		advanceTime(conf.get("room.unload_after") + 2);
		await updateRooms();
		expect(roommanager.rooms).not.toContain(room);
		expect(await redisClient.exists(`room:${room.name}`)).toBe(0);
	});

	it("leaves embedded players and live sources paused without creating an unsupported preparation", async () => {
		room.currentSource = { service: "youtube", id: "embedded-video", length: 600 };
		await watchThenLeave();
		await join("embedded-viewer");
		expect(room.playbackPreparation).toBeNull();
		expect(room.isPlaying).toBe(false);
		await leave("embedded-viewer");
		room.currentSource = { service: "hls", id: "live.m3u8" };
		await join("live-viewer");
		await room.play();
		await leave("live-viewer");
		await join("returning-live-viewer");
		expect(room.playbackPreparation).toBeNull();
		expect(room.isPlaying).toBe(false);
	});
});
