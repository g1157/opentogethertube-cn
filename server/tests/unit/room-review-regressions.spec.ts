import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import { buildClients } from "../../redisclient.js";
import tokens from "../../auth/tokens.js";
import { loadModels, Room as DbRoom } from "../../models/index.js";
import storage from "../../storage.js";
import * as sponsorblock from "../../sponsorblock.js";
import permissions, { Grants } from "ott-common/permissions.js";
import { Role } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import type { Segment } from "sponsorblock-api";
import { conf } from "../../ott-config.js";

describe("room review regressions", () => {
	let room: Room;
	beforeAll(async () => {
		loadModels();
		await buildClients();
	});
	beforeEach(() => {
		room = new Room({ name: "review-room-regressions", isTemporary: true });
		room.throttledSync.cancel();
		vi.spyOn(room, "throttledSync").mockReturnValue(undefined);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		await DbRoom.destroy({ where: { name: room.name } });
	});

	it("rejects an existing member's requests after their token is revoked", async () => {
		const token = "review-revoked-owner";
		await tokens.setSessionInfo(token, { isLoggedIn: true, user_id: 1111 });
		const member = new RoomUser("owner", token);
		member.user_id = 1111;
		room.realusers.push(member);
		room.grants.setRoleGrants(Role.RegisteredUser, ["configure-room.set-title"]);
		await room.processUnauthorizedRequest(
			{ type: RoomRequestType.ApplySettingsRequest, settings: { title: "valid session" } },
			{ token, clientId: "owner" },
		);
		expect(room.title).toBe("valid session");
		await tokens.revoke(token);
		await expect(
			room.processUnauthorizedRequest(
				{
					type: RoomRequestType.ApplySettingsRequest,
					settings: { title: "stale session" },
				},
				{ token, clientId: "owner" },
			),
		).rejects.toThrow();
		expect(room.title).not.toBe("stale session");
	});

	it("does not apply delayed SponsorBlock segments to a replacement source", async () => {
		let finish!: (segments: Segment[]) => void;
		vi.spyOn(sponsorblock, "fetchSegments").mockReturnValueOnce(
			new Promise(resolve => {
				finish = resolve;
			}),
		);
		room.currentSource = { service: "youtube", id: "source-a" };
		const pending = room.fetchSponsorBlockSegments();
		room.currentSource = { service: "youtube", id: "source-b" };
		finish([{ startTime: 5, endTime: 20, category: "sponsor" } as Segment]);
		await pending;
		expect(room.videoSegments).toEqual([]);
	});

	it("finishes a room tick while the external SponsorBlock request is still pending", async () => {
		const enabled = conf.get("video.sponsorblock.enabled");
		conf.set("video.sponsorblock.enabled", true);
		let finish!: (segments: Segment[]) => void;
		vi.spyOn(sponsorblock, "fetchSegments").mockReturnValueOnce(
			new Promise(resolve => {
				finish = resolve;
			}),
		);
		room.currentSource = { service: "youtube", id: "pending-segments" };
		room.wantSponsorBlock = true;
		let completed = false;
		const tick = (async () => {
			await room.update();
			completed = true;
		})();
		try {
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(completed).toBe(true);
		} finally {
			finish([]);
			await tick;
			conf.set("video.sponsorblock.enabled", enabled);
		}
	});

	it("persists the permissions revision with explicitly restricted grants", async () => {
		room.isTemporary = false;
		expect(await storage.saveRoom(room)).toBe(true);
		await DbRoom.update({ permissionsRevision: 0 }, { where: { name: room.name } });
		await room.setGrants(new Grants([[Role.UnregisteredUser, 0]]));
		await room.sync();
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.permissionsRevision).toBe(permissions.ROOM_PERMISSIONS_REVISION);
		const reloaded = new Room(saved!);
		try {
			expect(reloaded.grants.getMask(Role.UnregisteredUser)).toBe(0);
		} finally {
			reloaded.throttledSync.cancel();
			reloaded.saveStateToRedisDebounced.cancel();
		}
	});
});
