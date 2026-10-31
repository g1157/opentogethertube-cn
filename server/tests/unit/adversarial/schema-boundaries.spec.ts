import { describe, expect, it } from "vitest";
import { clientMessageSchema, undoEventSchema } from "../../../ws-schemas.js";
import {
	OttApiRequestAddToQueueSchema,
	OttApiRequestRoomCreateSchema,
	OttApiRequestUpdateQueueItemSchema,
	RoomSettingsSchema,
} from "ott-common/models/zod-schemas.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";

describe("client websocket envelope boundaries", () => {
	it("accepts the documented actions", () => {
		for (const message of [
			{ action: "auth", token: "t" },
			{ action: "reauthenticate", token: "t" },
			{ action: "kickme" },
			{ action: "status", status: "ready" },
			{ action: "notify", message: "usernameChanged" },
			{ action: "voice", joined: true },
			{ action: "ping", t0: Date.now() },
			{ action: "req", request: { type: RoomRequestType.SeekRequest, value: 1 } },
		]) {
			expect(clientMessageSchema.safeParse(message).success).toBe(true);
		}
	});

	it("rejects unknown actions and malformed envelopes", () => {
		for (const message of [
			null,
			[],
			"ping",
			{},
			{ action: "unknown" },
			{ action: "ping" },
			{ action: "ping", t0: "now" },
			{ action: "ping", t0: Number.NaN },
			{ action: "ping", t0: Number.POSITIVE_INFINITY },
			{ action: "voice", joined: "yes" },
			{ action: "signal", to: "x", signal: { kind: "offer" } },
			{ action: "signal", to: "x", signal: { kind: "offer", sdp: "x".repeat(16_385) } },
			{ action: "req", request: { type: "2" } },
			{ action: "req", request: { type: -1 } },
			{ action: "req", request: { type: 1000 } },
			{ action: "req", request: { type: 1.5 } },
		]) {
			expect(clientMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(
				false,
			);
		}
	});

	it("caps auth tokens and strips unknown envelope keys", () => {
		expect(
			clientMessageSchema.safeParse({ action: "auth", token: "x".repeat(1025) }).success,
		).toBe(false);
		const parsed = clientMessageSchema.parse({ action: "ping", t0: 1, evil: true }) as any;
		expect(parsed.evil).toBeUndefined();
	});

	it("does not validate the inner room request (the room must do it)", () => {
		// This is a documented boundary: the envelope only guards the discriminator, so the
		// room handlers are the security boundary for every request field.
		const parsed = clientMessageSchema.safeParse({
			action: "req",
			request: { type: RoomRequestType.SeekRequest, value: "not-a-number" },
		});
		expect(parsed.success).toBe(true);
	});
});

describe("undo event schema", () => {
	const video = { service: "direct", id: "episode.mp4" };

	it("accepts the event shapes a room can publish", () => {
		for (const event of [
			{ request: { type: RoomRequestType.SeekRequest }, additional: { prevPosition: 0 } },
			{
				request: { type: RoomRequestType.SkipRequest },
				additional: { video, prevPosition: 12.5 },
			},
			{ request: { type: RoomRequestType.AddRequest, video }, additional: {} },
			{
				request: { type: RoomRequestType.RemoveRequest, video },
				additional: { video, queueIdx: 3 },
			},
		]) {
			expect(undoEventSchema.safeParse(event).success).toBe(true);
		}
	});

	it("rejects forged services, positions and indices", () => {
		for (const event of [
			{ request: { type: 999 } },
			{ request: { type: RoomRequestType.ChatRequest } },
			{ request: { type: RoomRequestType.SkipRequest }, additional: { prevPosition: -1 } },
			{
				request: { type: RoomRequestType.SkipRequest },
				additional: { prevPosition: Number.NaN },
			},
			{
				request: { type: RoomRequestType.SkipRequest },
				additional: { prevPosition: Number.POSITIVE_INFINITY },
			},
			{ request: { type: RoomRequestType.AddRequest }, additional: { queueIdx: -1 } },
			{ request: { type: RoomRequestType.AddRequest }, additional: { queueIdx: 1.5 } },
			{
				request: { type: RoomRequestType.AddRequest },
				additional: { video: { service: "evil", id: "x" } },
			},
			{
				request: { type: RoomRequestType.AddRequest },
				additional: { video: { service: "direct", id: "" } },
			},
		]) {
			expect(undoEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(false);
		}
	});
});

describe("room settings boundary", () => {
	it("rejects unknown keys instead of silently accepting them", () => {
		expect(RoomSettingsSchema.safeParse({ title: "ok" }).success).toBe(true);
		expect(RoomSettingsSchema.safeParse({ title: "ok", evil: true }).success).toBe(false);
	});

	it("caps text fields and rejects newlines", () => {
		expect(RoomSettingsSchema.safeParse({ title: "x".repeat(254) }).success).toBe(true);
		expect(RoomSettingsSchema.safeParse({ title: "x".repeat(255) }).success).toBe(false);
		expect(RoomSettingsSchema.safeParse({ title: "a\nb" }).success).toBe(false);
		expect(RoomSettingsSchema.safeParse({ description: "x".repeat(5001) }).success).toBe(false);
	});

	it("constrains the danmaku source", () => {
		const valid = {
			videoUrl: "https://ana.girigirilove.com/x.mp4",
			provider: "girigiri",
			label: "Episode",
			page: "/playGV1-1-1/",
			offset: 0,
		};
		expect(RoomSettingsSchema.safeParse({ danmakuSource: valid }).success).toBe(true);
		expect(
			RoomSettingsSchema.safeParse({
				danmakuSource: { ...valid, provider: "arbitrary" },
			}).success,
		).toBe(false);
		expect(
			RoomSettingsSchema.safeParse({
				danmakuSource: { ...valid, page: "https://evil.example/" },
			}).success,
		).toBe(false);
		expect(
			RoomSettingsSchema.safeParse({ danmakuSource: { ...valid, offset: Number.NaN } })
				.success,
		).toBe(false);
		expect(
			RoomSettingsSchema.safeParse({ danmakuSource: { ...valid, offset: 601 } }).success,
		).toBe(false);
		expect(
			RoomSettingsSchema.safeParse({ danmakuSource: { ...valid, label: "x".repeat(201) } })
				.success,
		).toBe(false);
	});

	it("does not let a JSON __proto__ key mutate the parsed object", () => {
		const parsed = RoomSettingsSchema.safeParse(
			JSON.parse('{"__proto__":{"polluted":true},"title":"ok"}'),
		);
		expect(parsed.success).toBe(false);
		expect(({} as any).polluted).toBeUndefined();
	});
});

describe("REST request boundaries", () => {
	it("drops unknown fields on queue updates instead of applying them", () => {
		const parsed = OttApiRequestUpdateQueueItemSchema.parse({
			service: "direct",
			id: "episode.mp4",
			subtitleUrl: null,
			src_url: "http://evil.example/x.mp4",
			length: 0,
		}) as any;
		expect(parsed.src_url).toBeUndefined();
		expect(parsed.length).toBeUndefined();
	});

	it("caps ids and subtitle URLs", () => {
		expect(
			OttApiRequestUpdateQueueItemSchema.safeParse({
				service: "direct",
				id: "x".repeat(100_000),
			}).success,
		).toBe(false);
		expect(
			OttApiRequestUpdateQueueItemSchema.safeParse({
				service: "direct",
				id: "episode.mp4",
				subtitleUrl: `https://example.com/${"x".repeat(2048)}.vtt`,
			}).success,
		).toBe(false);
	});

	it("caps batch adds", () => {
		const videos = Array.from({ length: 10_000 }, (_, index) => ({
			service: "direct",
			id: `episode-${index}.mp4`,
		}));
		expect(OttApiRequestAddToQueueSchema.safeParse({ videos }).success).toBe(false);
	});

	it("enforces the room-name and password boundaries", () => {
		expect(OttApiRequestRoomCreateSchema.safeParse({ name: "ab" }).success).toBe(false);
		expect(OttApiRequestRoomCreateSchema.safeParse({ name: "a".repeat(33) }).success).toBe(
			false,
		);
		expect(OttApiRequestRoomCreateSchema.safeParse({ name: "list" }).success).toBe(false);
		expect(OttApiRequestRoomCreateSchema.safeParse({ name: "valid-room_1" }).success).toBe(
			true,
		);
		expect(
			OttApiRequestRoomCreateSchema.safeParse({ name: "valid-room", password: "123" })
				.success,
		).toBe(false);
		expect(
			OttApiRequestRoomCreateSchema.safeParse({
				name: "valid-room",
				title: "a\nb",
			}).success,
		).toBe(false);
	});
});

describe("grant masks", () => {
	it("rejects unknown roles in a settings grant", () => {
		expect(
			RoomSettingsSchema.safeParse({
				grants: [[999, 1]],
			}).success,
		).toBe(false);
		expect(
			RoomSettingsSchema.safeParse({
				grants: [[Role.UnregisteredUser, 1]],
			}).success,
		).toBe(true);
	});

	it("rejects masks that are not a 32-bit non-negative integer", () => {
		for (const mask of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5, 2 ** 32]) {
			expect(
				RoomSettingsSchema.safeParse({
					grants: [[Role.UnregisteredUser, mask]],
				}).success,
				String(mask),
			).toBe(false);
		}
	});
});
