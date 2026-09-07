import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import type { User } from "../../models/user.js";
import { buildClients } from "../../redisclient.js";
import {
	RoomRequestType,
	type RoomRequest,
	type ServerMessageEvent,
	type UndoRequest,
} from "ott-common/models/messages.js";
import { PlayerStatus, Role } from "ott-common/models/types.js";

describe("room mutations cannot bypass grants", () => {
	let room: Room;
	const context = { clientId: "guest", username: "guest", role: Role.UnregisteredUser };
	const current = { service: "direct" as const, id: "current.mp4", length: 120 };
	const previous = { service: "direct" as const, id: "previous.mp4", length: 120 };
	const queued = { service: "direct" as const, id: "queued.mp4", length: 120 };
	const undo = (request: RoomRequest): UndoRequest => ({
		type: RoomRequestType.UndoRequest,
		event: {
			action: "event",
			request,
			user: {
				id: "guest",
				name: "guest",
				role: Role.UnregisteredUser,
				isLoggedIn: false,
				status: PlayerStatus.ready,
			},
			additional: { video: previous, prevPosition: 0, queueIdx: 0 },
		} as ServerMessageEvent,
	});

	beforeAll(async () => {
		await buildClients();
	});
	beforeEach(async () => {
		room = new Room({ name: "room-authorization-test", isTemporary: true });
		room.realusers.push(new RoomUser(context.clientId, "test-guest-token"));
		room.currentSource = { ...current };
		await room.queue.enqueue({ ...queued });
		room.grants.setRoleGrants(Role.UnregisteredUser, []);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});
	afterEach(async () => {
		await room.onBeforeUnload();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.restoreAllMocks();
	});

	it.each([
		{ type: RoomRequestType.SeekRequest, value: 60 },
		{ type: RoomRequestType.SkipRequest },
		{ type: RoomRequestType.AddRequest, video: queued },
		{ type: RoomRequestType.RemoveRequest, video: previous },
	] as RoomRequest[])("requires grants when undoing operation $type", async eventRequest => {
		await expect(room.processRequest(undo(eventRequest), context)).rejects.toThrow();
		expect(room.currentSource).toEqual(current);
		expect(room.queue.items).toEqual([queued]);
		expect(room.playbackPosition).toBe(0);
	});

	it("requires skip permission before undoing an add by clearing the current video", async () => {
		await room.queue.set([]);
		room.grants.setRoleGrants(Role.UnregisteredUser, ["manage-queue.remove"]);
		await expect(
			room.processRequest(
				undo({ type: RoomRequestType.AddRequest, video: current }),
				context,
			),
		).rejects.toThrow();
		expect(room.currentSource).toEqual(current);
	});

	it.each([
		"playback.skip",
		"playback.seek",
		"manage-queue.add",
		"manage-queue.play-now",
	])("checks %s before making any partial change when undoing a skip", async missingGrant => {
		room.grants.setRoleGrants(
			Role.UnregisteredUser,
			["playback.skip", "playback.seek", "manage-queue.add", "manage-queue.play-now"].filter(
				grant => grant !== missingGrant,
			),
		);
		await expect(
			room.processRequest(undo({ type: RoomRequestType.SkipRequest }), context),
		).rejects.toThrow();
		expect(room.currentSource).toEqual(current);
		expect(room.queue.items).toEqual([queued]);
	});

	it("permits authorized undo at the start of a video", async () => {
		room.grants.setRoleGrants(Role.UnregisteredUser, ["playback", "manage-queue"]);
		await room.processRequest(undo({ type: RoomRequestType.SkipRequest }), context);
		expect(room.currentSource).toEqual(previous);
		expect(room.queue.items).toEqual([current, queued]);
		expect(room.playbackPosition).toBe(0);
		room.playbackPosition = 50;
		await room.processRequest(undo({ type: RoomRequestType.SeekRequest, value: 50 }), context);
		expect(room.playbackPosition).toBe(0);
	});

	it.each([
		false,
		true,
	])("requires the appropriate grant before restoring/discarding (%s)", async discard => {
		room.prevQueue = [previous];
		await expect(
			room.processRequest({ type: RoomRequestType.RestoreQueueRequest, discard }, context),
		).rejects.toThrow();
		expect(room.prevQueue).toEqual([previous]);
		expect(room.queue.items).toEqual([queued]);
		room.grants.setRoleGrants(Role.UnregisteredUser, [
			discard ? "manage-queue.remove" : "manage-queue.add",
		]);
		await room.processRequest({ type: RoomRequestType.RestoreQueueRequest, discard }, context);
		expect(room.prevQueue).toBeNull();
		expect(room.queue.items).toEqual(discard ? [queued] : [queued, previous]);
	});

	it.each([
		null,
		undefined,
		true,
		"4",
		999,
		-1,
		0,
		2.5,
		[4],
	])("rejects malformed/nonassignable promotion roles without removing existing roles: %j", async role => {
		const target = new RoomUser("target", "test-target-token");
		target.user_id = 314;
		target.user = { id: 314, username: "trusted-viewer" } as User;
		room.realusers.push(target);
		room.userRoles.get(Role.TrustedUser)!.add(target.user_id);
		await expect(
			room.processRequest(
				{
					type: RoomRequestType.PromoteRequest,
					targetClientId: target.id,
					role: role as Role,
				},
				context,
			),
		).rejects.toThrow();
		expect(room.getRole(target)).toBe(Role.TrustedUser);
	});

	it("allows an administrator to promote and demote a registered viewer", async () => {
		const target = new RoomUser("target", "test-target-token");
		target.user_id = 314;
		target.user = { id: 314, username: "registered-viewer" } as User;
		room.realusers.push(target);
		for (const role of [Role.Moderator, Role.RegisteredUser]) {
			await room.processRequest(
				{ type: RoomRequestType.PromoteRequest, targetClientId: target.id, role },
				{ ...context, role: Role.Administrator },
			);
			expect(room.getRole(target)).toBe(role);
		}
	});
});
