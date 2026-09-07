import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import { RoomRequestType, type TemporaryPlaybackSpeedRequest } from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";
import { TEMPORARY_PLAYBACK_SPEED_LEASE_MS } from "ott-common/constants.js";
import { buildClients } from "../../redisclient.js";

describe("temporary room playback speed", () => {
	let room: Room;
	const video = { service: "direct" as const, id: "test-episode-03.mp4", length: 600 };
	const context = (id = "alice") => ({ clientId: id, username: id, role: Role.UnregisteredUser });
	const request = (
		action: TemporaryPlaybackSpeedRequest["action"],
		gestureId = "hold-alice",
		id = "alice",
	) =>
		room.processRequest(
			{ type: RoomRequestType.TemporaryPlaybackSpeedRequest, action, gestureId, video },
			context(id),
		);

	beforeAll(async () => {
		await buildClients();
	});
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-07T08:00:00Z"));
		room = new Room({ name: "temporary-speed-test", isTemporary: true });
		room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.speed", "playback.play-pause"]);
		room.realusers = [new RoomUser("alice", "test-alice"), new RoomUser("bob", "test-bob")];
		room.currentSource = video;
		room.playbackSpeed = 1.5;
		room.playbackPosition = 10;
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		await room.play();
	});
	afterEach(async () => {
		await room.onBeforeUnload();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("synchronizes the speed and keeps the playback position continuous when releasing", async () => {
		await vi.advanceTimersByTimeAsync(1000);
		await request("start");
		expect(room.playbackSpeed).toBe(2);
		expect(room.realPlaybackPosition).toBeCloseTo(11.5);
		await room.sync();
		expect(room.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "sync",
				playbackSpeed: 2,
				temporaryPlaybackSpeed: { clientId: "alice", gestureId: "hold-alice", speed: 2 },
			}),
		);
		await vi.advanceTimersByTimeAsync(1000);
		await request("stop");
		expect(room.playbackSpeed).toBe(1.5);
		expect(room.temporaryPlaybackSpeed).toBeNull();
		expect(room.realPlaybackPosition).toBeCloseTo(13.5);
		await vi.advanceTimersByTimeAsync(2000);
		expect(room.realPlaybackPosition).toBeCloseTo(16.5);
	});

	it("expires a lost gesture without a release or further messages", async () => {
		await request("start");
		await vi.advanceTimersByTimeAsync(TEMPORARY_PLAYBACK_SPEED_LEASE_MS);
		expect(room.playbackSpeed).toBe(1.5);
		expect(room.temporaryPlaybackSpeed).toBeNull();
		await request("renew");
		expect(room.playbackSpeed).toBe(1.5);
	});

	it("extends a live gesture only when its owning client renews it", async () => {
		await request("start");
		await vi.advanceTimersByTimeAsync(4000);
		await request("renew");
		await vi.advanceTimersByTimeAsync(4000);
		expect(room.playbackSpeed).toBe(2);
		await request("renew", "hold-alice", "bob");
		await vi.advanceTimersByTimeAsync(1000);
		expect(room.playbackSpeed).toBe(1.5);
	});

	it("does not let another viewer take or release the current gesture", async () => {
		await request("start");
		await request("start", "hold-bob", "bob");
		await request("stop", "hold-alice", "bob");
		expect(room.temporaryPlaybackSpeed?.clientId).toBe("alice");
		await request("stop");
		expect(room.playbackSpeed).toBe(1.5);
	});

	it.each([1.25, 2])("preserves a later explicit speed change to %s", async speed => {
		await request("start");
		await room.processRequest(
			{ type: RoomRequestType.PlaybackSpeedRequest, speed },
			context("bob"),
		);
		await request("renew");
		await request("stop");
		await vi.advanceTimersByTimeAsync(6000);
		expect(room.playbackSpeed).toBe(speed);
		expect(room.temporaryPlaybackSpeed).toBeNull();
	});

	it("restores speed when its owner disconnects while another viewer remains", async () => {
		await request("start");
		await room.leaveRoom({ type: RoomRequestType.LeaveRequest }, context());
		expect(room.playbackSpeed).toBe(1.5);
		expect(room.isPlaying).toBe(true);
		expect(room.realusers.map(user => user.id)).toEqual(["bob"]);
	});

	it("cancels on pause and on changing videos", async () => {
		await request("start");
		await room.pause();
		expect(room.playbackSpeed).toBe(1.5);
		await room.play();
		await request("start");
		await room.queue.enqueue({ service: "direct", id: "next.mp4", length: 600 });
		await room.dequeueNext();
		await request("renew");
		await request("stop");
		expect(room.currentSource?.id).toBe("next.mp4");
		expect(room.playbackSpeed).toBe(1);
		expect(room.temporaryPlaybackSpeed).toBeNull();
	});

	it("restores on room unload and never stores the temporary speed in Redis", async () => {
		await request("start");
		await vi.advanceTimersByTimeAsync(1000);
		const snapshot = JSON.parse(room.serializeState());
		expect(snapshot.playbackSpeed).toBe(1.5);
		expect(snapshot.playbackPosition).toBeCloseTo(12);
		expect(snapshot).not.toHaveProperty("temporaryPlaybackSpeed");
		await room.onBeforeUnload();
		expect(room.playbackSpeed).toBe(1.5);
		expect(room.temporaryPlaybackSpeed).toBeNull();
	});

	it("checks permission and still permits releasing after permission is revoked", async () => {
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		await expect(request("start")).rejects.toThrow();
		expect(room.playbackSpeed).toBe(1.5);
		room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.speed"]);
		await request("start");
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		await request("stop");
		expect(room.playbackSpeed).toBe(1.5);
	});

	it("restores when a speed grant is removed", async () => {
		await request("start");
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		await room.update();
		expect(room.playbackSpeed).toBe(1.5);
	});

	it("ignores a stale source, a paused video, and live media", async () => {
		room.currentSource = { ...video, id: "other.mp4" };
		await request("start");
		expect(room.playbackSpeed).toBe(1.5);
		room.currentSource = video;
		await room.pause();
		await request("start");
		expect(room.temporaryPlaybackSpeed).toBeNull();
		room.currentSource = { ...video, length: undefined };
		await room.play();
		await request("start");
		expect(room.temporaryPlaybackSpeed).toBeNull();
	});

	it("requires a connected member and a valid bounded gesture identifier", async () => {
		await expect(request("start", "hold-unknown", "unknown")).rejects.toThrow();
		await expect(request("start", "x".repeat(65))).rejects.toThrow();
		await expect(
			request("unexpected" as TemporaryPlaybackSpeedRequest["action"]),
		).rejects.toThrow();
		expect(room.playbackSpeed).toBe(1.5);
	});

	it.each([
		NaN,
		Infinity,
		-1,
		0,
		5,
	])("rejects invalid persistent playback speed %s", async speed => {
		await expect(
			room.processRequest({ type: RoomRequestType.PlaybackSpeedRequest, speed }, context()),
		).rejects.toThrow();
		expect(room.playbackSpeed).toBe(1.5);
	});
});
