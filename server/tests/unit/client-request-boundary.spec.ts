import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import clientmanager from "../../clientmanager.js";
import { Client, ClientJoinStatus } from "../../client.js";
import roommanager from "../../roommanager.js";
import { Room, RoomUser } from "../../room.js";
import usermanager from "../../usermanager.js";
import type { User } from "../../models/user.js";
import { buildClients } from "../../redisclient.js";
import { ok } from "ott-common/result.js";
import {
	RoomRequestType,
	type RoomRequest,
	type ClientMessage,
} from "ott-common/models/messages.js";
import { OttWebsocketError, PlayerStatus, Role } from "ott-common/models/types.js";

class ConnectedGuest extends Client {
	sendRaw = vi.fn();
	kick = vi.fn();
	get clientType() {
		return "test";
	}
}

describe("client room request authorization boundary", () => {
	let room: Room;
	let client: ConnectedGuest;
	let guest: RoomUser;
	const owner = { id: 101, username: "room-owner" } as User;
	const settleMessages = () => new Promise<void>(resolve => setImmediate(resolve));

	beforeAll(async () => {
		await buildClients();
	});
	beforeEach(() => {
		room = new Room({ name: "request-boundary-room", isTemporary: true, owner });
		client = new ConnectedGuest(room.name);
		client.token = "test-guest-token";
		client.session = { isLoggedIn: false, username: "guest" };
		client.joinStatus = ClientJoinStatus.Joined;
		guest = new RoomUser(client.id, client.token);
		guest.unregisteredUsername = "guest";
		room.realusers.push(guest);
		vi.spyOn(roommanager, "getRoom").mockResolvedValue(ok(room));
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		vi.spyOn(usermanager, "getUser").mockResolvedValue(owner);
		clientmanager.addClient(client);
	});
	afterEach(async () => {
		client.emit("disconnect", client);
		await settleMessages();
		await room.onBeforeUnload();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.restoreAllMocks();
	});

	async function request(value: unknown) {
		client.emit("message", client, { action: "req", request: value as RoomRequest });
		await settleMessages();
	}

	it("prevents a guest from impersonating the owner through an internal user update", async () => {
		await request({
			type: RoomRequestType.UpdateUser,
			info: { id: client.id, user_id: owner.id },
		});
		expect(client.kick).toHaveBeenCalledWith(OttWebsocketError.UNKNOWN);
		expect(usermanager.getUser).not.toHaveBeenCalled();
		expect(guest.user_id).toBeUndefined();
		expect(room.getRole(guest)).toBe(Role.UnregisteredUser);
		expect(room.owner).toBe(owner);
	});

	it.each([
		RoomRequestType.JoinRequest,
		RoomRequestType.LeaveRequest,
	])("rejects externally supplied membership request %s", async type => {
		const process = vi.spyOn(room, "processUnauthorizedRequest");
		await request({ type, info: { id: "forged-owner", user_id: owner.id } });
		expect(client.kick).toHaveBeenCalledWith(OttWebsocketError.UNKNOWN);
		expect(process).not.toHaveBeenCalled();
		expect(room.realusers).toEqual([guest]);
	});

	it.each([
		null,
		[],
		"play",
		{},
		{ type: "2" },
		{ type: -1 },
		{ type: 999 },
	])("rejects malformed or unknown room requests: %j", async value => {
		const process = vi.spyOn(room, "processUnauthorizedRequest");
		await request(value);
		expect(client.kick).toHaveBeenCalledWith(OttWebsocketError.UNKNOWN);
		expect(process).not.toHaveBeenCalled();
	});

	it("continues to accept ordinary speed changes and the new temporary speed requests", async () => {
		const video = { service: "direct" as const, id: "test-video.mp4", length: 120 };
		room.currentSource = video;
		await room.play();
		await request({ type: RoomRequestType.PlaybackSpeedRequest, speed: 1.5 });
		expect(room.playbackSpeed).toBe(1.5);
		await request({
			type: RoomRequestType.TemporaryPlaybackSpeedRequest,
			action: "start",
			gestureId: "test-hold",
			video,
		});
		expect(room.playbackSpeed).toBe(2);
		await request({
			type: RoomRequestType.TemporaryPlaybackSpeedRequest,
			action: "stop",
			gestureId: "test-hold",
			video,
		});
		expect(room.playbackSpeed).toBe(1.5);
		expect(client.kick).not.toHaveBeenCalled();
	});

	it("keeps server-built status updates while ignoring supplied identity fields", async () => {
		client.emit("message", client, {
			action: "status",
			status: PlayerStatus.ready,
			info: { id: client.id, user_id: owner.id },
		} as unknown as ClientMessage);
		await settleMessages();
		expect(guest.playerStatus).toBe(PlayerStatus.ready);
		expect(guest.user_id).toBeUndefined();
		expect(room.getRole(guest)).toBe(Role.UnregisteredUser);
		expect(client.kick).not.toHaveBeenCalled();
	});

	it("binds a playback-prepared status to the authenticated connection, not supplied identity", async () => {
		room.currentSource = { service: "direct", id: "episode-03.mp4", length: 600 };
		room.playbackPosition = 120;
		await room.play();
		await room.leaveRoom(
			{ type: RoomRequestType.LeaveRequest },
			{ clientId: client.id, username: "guest", role: Role.UnregisteredUser },
		);
		await room.joinRoom(
			{
				type: RoomRequestType.JoinRequest,
				info: { id: client.id, username: "guest" },
			},
			{
				clientId: client.id,
				username: "guest",
				role: Role.UnregisteredUser,
				auth: { token: client.token!, clientId: client.id },
			},
		);
		const preparation = room.playbackPreparation!;
		expect(preparation.clientId).toBe(client.id);
		client.emit("message", client, {
			action: "status",
			status: PlayerStatus.ready,
			playbackPrepared: { id: preparation.id, position: preparation.position },
			info: { id: "forged-other-client", user_id: owner.id },
		} as unknown as ClientMessage);
		await settleMessages();
		expect(room.isPlaying).toBe(true);
		expect(room.playbackPreparation).toBeNull();
		expect(room.getRole(room.getUser(client.id))).toBe(Role.UnregisteredUser);
		expect(client.kick).not.toHaveBeenCalled();
	});
});
