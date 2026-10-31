import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import { Room, RoomUser } from "../../../room.js";
import { VideoQueue } from "../../../videoqueue.js";
import InfoExtract from "../../../infoextractor.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { QueueMode, Role, Visibility } from "ott-common/models/types.js";
import { PermissionDeniedException } from "ott-common/exceptions.js";
import {
	MAX_CHAT_MESSAGE_LENGTH,
	MAX_QUEUE_ITEMS,
	MAX_SEEK_SECONDS,
	MAX_VIDEO_ID_LENGTH,
} from "ott-common/constants.js";
import { UndoEventUnavailable, UnsupportedSubtitleUrl } from "../../../exceptions.js";

const OWNER = { id: 9001, username: "owner" } as any;

describe("room request boundary attacks", () => {
	let room: Room;
	let guest: RoomUser;
	let requestSequence: number;

	const context = () => ({
		clientId: guest.id,
		username: "guest",
		role: Role.UnregisteredUser,
	});

	beforeEach(() => {
		requestSequence = (requestSequence ?? 0) + 1;
		room = new Room({
			name: `adversarial-${requestSequence}`,
			isTemporary: true,
			owner: OWNER,
		});
		guest = new RoomUser("guest-client", "guest-token");
		guest.unregisteredUsername = "guest";
		room.realusers.push(guest);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await room.onBeforeUnload();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	function send(request: any) {
		return room.processRequest(request, context());
	}

	describe("SeekRequest", () => {
		it.each([
			["a numeric string", "60"],
			["a number past the clock cap", 1e308],
			["a negative position", -1],
			["an object", { value: 60 }],
			["a boolean", true],
			["NaN", Number.NaN],
			["Infinity", Number.POSITIVE_INFINITY],
		])("does not accept %s", async (_label, value) => {
			room.currentSource = { service: "direct", id: "episode.mp4", length: 1500 };
			await room.play();
			const before = room.playbackPosition;

			await expect(send({ type: RoomRequestType.SeekRequest, value })).rejects.toThrow();

			expect(Number.isFinite(room.playbackPosition)).toBe(true);
			expect(room.playbackPosition).toBeGreaterThanOrEqual(0);
			expect(room.playbackPosition).toBeLessThanOrEqual(MAX_SEEK_SECONDS);
			expect(room.playbackPosition).toBe(before);
		});

		it("ignores missing values without corrupting the clock", async () => {
			room.currentSource = { service: "direct", id: "episode.mp4", length: 1500 };
			await room.play();
			const before = room.playbackPosition;

			await send({ type: RoomRequestType.SeekRequest, value: null });
			await send({ type: RoomRequestType.SeekRequest, value: undefined });

			expect(room.playbackPosition).toBe(before);
			expect(Number.isFinite(room.playbackPosition)).toBe(true);
		});
	});

	describe("UpdateQueueItemRequest", () => {
		it("only lets a queue update change the subtitle URL", async () => {
			room.queue = new VideoQueue([
				{
					service: "direct",
					id: "episode.mp4",
					title: "Episode",
					length: 120,
				} as any,
			]);
			const item = room.queue.items[0];

			await send({
				type: RoomRequestType.UpdateQueueItemRequest,
				video: { service: "direct", id: "episode.mp4" },
				update: {
					subtitleUrl: null,
					id: "http://evil.example/x.mp4",
					service: "hls",
					src_url: "http://evil.example/x.mp4",
					length: 0,
					thumbnail: "http://evil.example/x.jpg",
					startAt: 0,
				},
			});

			expect(item.service).toBe("direct");
			expect(item.id).toBe("episode.mp4");
			expect(item.title).toBe("Episode");
			expect(item.length).toBe(120);
			expect((item as any).src_url).toBeUndefined();
			expect((item as any).thumbnail).toBeUndefined();
			expect(item.subtitleUrl).toBeUndefined();
		});

		it("rejects a subtitle host that resolves to loopback", async () => {
			vi.stubEnv("NODE_ENV", "production");
			vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
			room.queue = new VideoQueue([{ service: "direct", id: "episode.mp4" }]);

			await expect(
				send({
					type: RoomRequestType.UpdateQueueItemRequest,
					video: { service: "direct", id: "episode.mp4" },
					update: { subtitleUrl: "http://127.0.0.1.nip.io/subs.vtt" },
				}),
			).rejects.toThrow(UnsupportedSubtitleUrl);

			expect(room.queue.items[0].subtitleUrl).toBeUndefined();
		});

		it("does not let the patch replace the item prototype", async () => {
			room.queue = new VideoQueue([{ service: "direct", id: "episode.mp4" } as any]);
			const item = room.queue.items[0];
			const update = JSON.parse('{"__proto__":{"polluted":true}}');

			await send({
				type: RoomRequestType.UpdateQueueItemRequest,
				video: { service: "direct", id: "episode.mp4" },
				update,
			});

			expect((item as any).polluted).toBeUndefined();
			expect(({} as any).polluted).toBeUndefined();
			expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
		});
	});

	describe("PlayNowRequest", () => {
		it("rejects an internal subtitle URL before mutating the room", async () => {
			room.currentSource = { service: "direct", id: "current.mp4", length: 100 };
			room.queue = new VideoQueue([{ service: "direct", id: "next.mp4", length: 100 }]);

			await expect(
				send({
					type: RoomRequestType.PlayNowRequest,
					video: {
						service: "direct",
						id: "next.mp4",
						subtitleUrl: "http://127.0.0.1/subs.vtt",
					},
				}),
			).rejects.toThrow(UnsupportedSubtitleUrl);

			expect(room.currentSource.id).toBe("current.mp4");
			expect(room.queue.length).toBe(1);
			expect(room.queue.items[0].subtitleUrl).toBeUndefined();
		});
	});

	describe("ChatRequest", () => {
		it("rejects text past the shared chat cap", async () => {
			const published: any[] = [];
			(room.publish as any).mockImplementation(async (message: any) => {
				published.push(message);
			});

			await expect(
				send({
					type: RoomRequestType.ChatRequest,
					text: "x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1_000),
				}),
			).rejects.toThrow();

			expect(published).toHaveLength(0);
		});

		it("rejects non-string chat payloads", async () => {
			await expect(
				send({ type: RoomRequestType.ChatRequest, text: { not: "a string" } }),
			).rejects.toThrow();
		});
	});

	describe("video identity bounds", () => {
		it("rejects an oversized add URL before probing it", async () => {
			const getInfo = vi.spyOn(InfoExtract, "getVideoInfo").mockResolvedValue({} as any);

			await expect(
				send({
					type: RoomRequestType.AddRequest,
					url: `https://example.com/${"a".repeat(MAX_VIDEO_ID_LENGTH)}`,
				}),
			).rejects.toThrow();
			expect(getInfo).not.toHaveBeenCalled();
		});

		it("rejects an oversized playNow id before probing it", async () => {
			const getInfo = vi.spyOn(InfoExtract, "getVideoInfo").mockResolvedValue({} as any);

			await expect(
				send({
					type: RoomRequestType.PlayNowRequest,
					video: { service: "direct", id: "a".repeat(MAX_VIDEO_ID_LENGTH + 1) },
				}),
			).rejects.toThrow();
			expect(getInfo).not.toHaveBeenCalled();
		});
	});

	describe("queue growth", () => {
		it("refuses an add once the queue is at the cap", async () => {
			room.queue = new VideoQueue(
				Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => ({
					service: "direct",
					id: `queued-${index}.mp4`,
					length: 10,
				})),
			);
			vi.spyOn(InfoExtract, "getVideoInfo").mockResolvedValue({
				service: "direct",
				id: "new.mp4",
				length: 10,
			} as any);

			await expect(
				send({
					type: RoomRequestType.AddRequest,
					video: { service: "direct", id: "new.mp4" },
				}),
			).rejects.toThrow();

			expect(room.queue.length).toBe(MAX_QUEUE_ITEMS);
		});

		it("keeps the cap under two concurrent adds", async () => {
			room.queue = new VideoQueue(
				Array.from({ length: MAX_QUEUE_ITEMS - 1 }, (_, index) => ({
					service: "direct",
					id: `queued-${index}.mp4`,
					length: 10,
				})),
			);
			vi.spyOn(InfoExtract, "getVideoInfo").mockImplementation(
				async (service, id) => ({ service, id, length: 10 }) as any,
			);

			const results = await Promise.allSettled([
				send({
					type: RoomRequestType.AddRequest,
					video: { service: "direct", id: "concurrent-a.mp4" },
				}),
				send({
					type: RoomRequestType.AddRequest,
					video: { service: "direct", id: "concurrent-b.mp4" },
				}),
			]);

			expect(room.queue.length).toBe(MAX_QUEUE_ITEMS);
			expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		});

		it("does not let restoreQueue grow past the cap", async () => {
			room.prevQueue = Array.from({ length: MAX_QUEUE_ITEMS + 1 }, (_, index) => ({
				service: "direct",
				id: `restored-${index}.mp4`,
				length: 10,
			})) as any;

			await expect(
				send({ type: RoomRequestType.RestoreQueueRequest, discard: false }),
			).rejects.toThrow();

			expect(room.queue.length).toBe(0);
		});
	});

	describe("private room boundary", () => {
		it("requires a password before a room can become private", async () => {
			guest.user_id = OWNER.id;
			guest.user = OWNER;
			const ownerContext = {
				clientId: guest.id,
				username: "owner",
				role: Role.Owner,
			};

			await expect(
				room.processRequest(
					{
						type: RoomRequestType.ApplySettingsRequest,
						settings: { visibility: Visibility.Private },
					},
					ownerContext,
				),
			).rejects.toThrow();

			room.setPasswordHash("stored-hash");
			await room.processRequest(
				{
					type: RoomRequestType.ApplySettingsRequest,
					settings: { visibility: Visibility.Private },
				},
				ownerContext,
			);

			expect(room.visibility).toBe(Visibility.Private);
		});
	});

	describe("queue modes at the cap", () => {
		it("keeps Loop playback cycling when the queue is full", async () => {
			room.queueMode = QueueMode.Loop;
			room.currentSource = { service: "direct", id: "current.mp4", length: 10 };
			room.queue = new VideoQueue(
				Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => ({
					service: "direct",
					id: `queued-${index}.mp4`,
					length: 10,
				})),
			);

			await expect(room.dequeueNext()).resolves.toBeUndefined();

			expect(room.queue.length).toBe(MAX_QUEUE_ITEMS);
			expect(room.currentSource?.id).toBe("queued-0.mp4");
		});
	});

	describe("UndoRequest", () => {
		it("consumes the matched event so it cannot be replayed", async () => {
			room.currentSource = { service: "direct", id: "A.mp4", length: 100 };
			room.queue = new VideoQueue([{ service: "direct", id: "B.mp4", length: 100 }]);
			await room.play();

			await send({ type: RoomRequestType.SkipRequest });
			const event = (room as any).recentEvents.at(-1);
			expect(event).toBeTruthy();

			await send({ type: RoomRequestType.UndoRequest, event });
			const afterFirstUndo = room.queue.length;

			await expect(send({ type: RoomRequestType.UndoRequest, event })).rejects.toThrow(
				UndoEventUnavailable,
			);

			expect(room.queue.length).toBe(afterFirstUndo);
		});
	});

	describe("permission boundary", () => {
		it("denies a guest kicking another viewer", async () => {
			await expect(
				send({ type: RoomRequestType.KickRequest, clientId: guest.id }),
			).rejects.toThrow(PermissionDeniedException);
		});

		it("denies a guest removing a queue item", async () => {
			room.queue = new VideoQueue([{ service: "direct", id: "episode.mp4" }]);
			await expect(
				send({
					type: RoomRequestType.RemoveRequest,
					video: { service: "direct", id: "episode.mp4" },
				}),
			).rejects.toThrow(PermissionDeniedException);
		});

		it("denies a guest changing the room title", async () => {
			await expect(
				send({
					type: RoomRequestType.ApplySettingsRequest,
					settings: { title: "owned" },
				}),
			).rejects.toThrow(PermissionDeniedException);
		});

		it("denies a guest granting itself moderator powers", async () => {
			const before = room.grants.getMask(Role.UnregisteredUser);
			await expect(
				send({
					type: RoomRequestType.ApplySettingsRequest,
					settings: {
						grants: new Map([[Role.UnregisteredUser, 0xffffffff]]),
					},
				}),
			).rejects.toThrow();

			expect(room.grants.getMask(Role.UnregisteredUser)).toBe(before);
		});
	});

	describe("OrderRequest", () => {
		it("rejects non-integer queue indices", async () => {
			room.queue = new VideoQueue([
				{ service: "direct", id: "a.mp4" },
				{ service: "direct", id: "b.mp4" },
				{ service: "direct", id: "c.mp4" },
			]);
			const before = room.queue.items.map(item => item.id);

			await expect(
				send({ type: RoomRequestType.OrderRequest, fromIdx: Number.NaN, toIdx: 1 }),
			).rejects.toThrow();
			await expect(
				send({ type: RoomRequestType.OrderRequest, fromIdx: 0.5, toIdx: 2 }),
			).rejects.toThrow();

			expect(room.queue.items.map(item => item.id)).toEqual(before);
		});
	});
});
