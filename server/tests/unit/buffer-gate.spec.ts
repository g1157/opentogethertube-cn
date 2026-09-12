import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferGateMode, PlayerStatus, Role } from "ott-common/models/types.js";
import { RoomRequestType, type RoomRequestContext } from "ott-common/models/messages.js";
import { BUFFER_GATE_MAX_WAIT_MS, BUFFER_GATE_COOLDOWN_MS } from "ott-common/constants.js";
import { Room } from "../../room.js";
import roommanager from "../../roommanager.js";
import { buildClients } from "../../redisclient.js";
import { conf } from "../../ott-config.js";
import storage from "../../storage.js";

describe("room buffering gate", () => {
	let room: Room;
	const video = { service: "direct" as const, id: "gate-video.mp4", length: 600 };
	const context = (id: string): RoomRequestContext => ({
		clientId: id,
		username: id,
		role: Role.UnregisteredUser,
		auth: { token: `test-${id}`, clientId: id },
	});
	const advance = (milliseconds: number) => vi.setSystemTime(Date.now() + milliseconds);
	const join = (id: string) =>
		room.joinRoom(
			{ type: RoomRequestType.JoinRequest, info: { id, username: id } },
			context(id),
		);
	const leave = (id: string) =>
		room.leaveRoom({ type: RoomRequestType.LeaveRequest }, context(id));
	const report = (id: string, status = PlayerStatus.buffering) =>
		room.updateUser({ type: RoomRequestType.UpdateUser, info: { id, status } }, context(id));

	beforeAll(async () => {
		await buildClients();
		conf.set("video.sponsorblock.enabled", false);
	});
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-12T08:00:00Z"));
		vi.spyOn(storage, "updateRoom").mockResolvedValue(true);
		room = new Room({ name: "buffer-gate-room", isTemporary: true });
		room.currentSource = video;
		room.playbackPosition = 120;
		room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.play-pause", "playback.speed"]);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});
	afterEach(async () => {
		await room.pause();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		roommanager.clearRooms();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function start(count = 2, mode = BufferGateMode.Pause) {
		room.bufferGateMode = mode;
		for (const id of ["alice", "bob", "carol"].slice(0, count)) {
			await join(id);
		}
		await room.play();
		advance(2100);
	}

	it("is off by default and leaves buffering clients independent", async () => {
		expect(room.bufferGateMode).toBe(BufferGateMode.Off);
		await start(2, BufferGateMode.Off);
		await report("bob");
		expect(room.isPlaying).toBe(true);
		expect(room.bufferingGateHeld).toBe(false);
	});

	it("holds the room clock when one of two authorized viewers buffers", async () => {
		await start();
		await report("bob");
		expect(room.isPlaying).toBe(false);
		expect(room.bufferingGateHeld).toBe(true);
		const position = room.realPlaybackPosition;
		advance(3000);
		expect(room.realPlaybackPosition).toBe(position);
		await room.update();
		expect(room.bufferingGateHeld).toBe(true);
	});

	it("does not gate a single viewer", async () => {
		await start(1);
		await report("alice");
		expect(room.isPlaying).toBe(true);
	});

	it.each([
		PlayerStatus.ready,
		PlayerStatus.error,
		PlayerStatus.none,
	])("does not treat %s as buffering", async status => {
		await start();
		await report("alice", PlayerStatus.ready);
		await report("bob", status);
		expect(room.isPlaying).toBe(true);
	});

	it("does not make a newcomer with no report block existing playback", async () => {
		await start(1);
		await report("alice", PlayerStatus.ready);
		await join("bob");
		await room.update();
		expect(room.isPlaying).toBe(true);
	});

	it("allows two seconds after play and evaluates again without another status report", async () => {
		await start();
		await room.pause();
		await room.play();
		await report("bob");
		expect(room.isPlaying).toBe(true);
		advance(1999);
		await room.update();
		expect(room.isPlaying).toBe(true);
		advance(101);
		await room.update();
		expect(room.bufferingGateHeld).toBe(true);
	});

	it("resumes when the last waiting viewer is ready and gives playback a new grace period", async () => {
		await start();
		await report("bob");
		await report("bob", PlayerStatus.ready);
		expect(room.isPlaying).toBe(true);
		expect(room.bufferingGateHeld).toBe(false);
		await report("bob");
		expect(room.isPlaying).toBe(true);
	});

	it("resumes after fifteen seconds and does not recapture during the thirty second cooldown", async () => {
		await start();
		await report("bob");
		advance(BUFFER_GATE_MAX_WAIT_MS - 1);
		await room.update();
		expect(room.isPlaying).toBe(false);
		advance(1);
		await room.update();
		expect(room.isPlaying).toBe(true);
		expect(room.bufferingGateHeld).toBe(false);
		advance(BUFFER_GATE_COOLDOWN_MS - 1);
		await report("bob");
		await room.update();
		expect(room.isPlaying).toBe(true);
		advance(1);
		await room.update();
		expect(room.bufferingGateHeld).toBe(true);
	});

	it("honors an explicit play while held without immediately pausing again", async () => {
		await start();
		await report("bob");
		await room.play();
		advance(3000);
		await report("bob");
		expect(room.isPlaying).toBe(true);
		expect(room.bufferingGateHeld).toBe(false);
	});

	it("does not resume a manual pause when waiting clients recover or the timeout expires", async () => {
		await start();
		await report("bob");
		await room.pause();
		await report("bob", PlayerStatus.ready);
		advance(20000);
		await room.update();
		expect(room.isPlaying).toBe(false);
		expect(room.bufferingGateHeld).toBe(false);
		room.bufferGateMode = BufferGateMode.Off;
		await room.update();
		expect(room.isPlaying).toBe(false);
	});

	it("releases its own pause when the setting is disabled", async () => {
		await start();
		await report("bob");
		await room.applySettings(
			{
				type: RoomRequestType.ApplySettingsRequest,
				settings: { bufferGateMode: BufferGateMode.Off },
			},
			{ ...context("alice"), role: Role.Owner },
		);
		expect(room.isPlaying).toBe(true);
		expect(room.bufferingGateHeld).toBe(false);
	});

	it("ignores viewers without play/pause permission", async () => {
		await start(3);
		// Registered roles inherit guest grants; make the waiting guest the lower role.
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		room.getUser("alice")!.user_id = 41;
		room.getUser("carol")!.user_id = 43;
		room.grants.setRoleGrants(Role.RegisteredUser, ["playback.play-pause"]);
		await report("bob");
		expect(room.isPlaying).toBe(true);
		await report("carol");
		expect(room.bufferingGateHeld).toBe(true);
	});

	it("releases a hold when the waiting viewer loses permission", async () => {
		await start();
		await report("bob");
		room.getUser("alice")!.user_id = 41;
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		await room.update();
		expect(room.isPlaying).toBe(true);
	});

	it.each([
		PlayerStatus.ready,
		PlayerStatus.buffering,
	])("does not interfere with temporary 2x (initial status=%s)", async status => {
		await start();
		await report("bob", status);
		await room.setTemporaryPlaybackSpeed(
			{
				type: RoomRequestType.TemporaryPlaybackSpeedRequest,
				action: "start",
				gestureId: "gate-test",
				video,
			},
			context("alice"),
		);
		advance(2100);
		await report("bob");
		expect(room.isPlaying).toBe(true);
		expect(room.playbackSpeed).toBe(2);
		expect(room.bufferingGateHeld).toBe(false);
	});

	it("does not resume over a playback preparation handshake", async () => {
		await start();
		await report("bob");
		room.playbackPreparation = { id: "prepare", clientId: "alice", video, position: 120 };
		await room.update();
		expect(room.isPlaying).toBe(false);
		expect(room.playbackPreparation?.id).toBe("prepare");
		expect(room.bufferingGateHeld).toBe(false);
	});

	it("resumes immediately if the waiting viewer leaves", async () => {
		await start();
		await report("bob");
		await leave("bob");
		expect(room.isPlaying).toBe(true);
		expect(room.bufferingGateHeld).toBe(false);
	});

	it("preserves resume intent when a gated room empties and prepares the next viewer", async () => {
		await start();
		await report("bob");
		await leave("alice");
		await leave("bob");
		expect(room.bufferingGateHeld).toBe(false);
		expect(room.isPlaying).toBe(false);
		expect(room.resumeOnNextJoin).toBe(true);
		await join("next");
		expect(room.playbackPreparation?.clientId).toBe("next");
	});

	it("checkpoints resume intent but never persists the transient gate", async () => {
		await start();
		await report("bob");
		const saved = JSON.parse(room.serializeState());
		expect(saved.resumeOnNextJoin).toBe(true);
		expect(saved.bufferGateMode).toBe(BufferGateMode.Pause);
		expect(saved).not.toHaveProperty("bufferGate");
		expect(room.syncableState()).not.toHaveProperty("bufferGate");
	});

	it("does not let the previous video's readiness resume a replacement source", async () => {
		await start();
		await report("bob");
		room.currentSource = { ...video, id: "next.mp4" };
		await report("bob", PlayerStatus.ready);
		expect(room.bufferingGateHeld).toBe(false);
		expect(room.isPlaying).toBe(false);
	});
});
