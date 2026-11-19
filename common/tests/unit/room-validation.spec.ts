import { describe, expect, it } from "vitest";
import { OttApiRequestRoomCreateSchema, RoomSettingsSchema } from "../../models/zod-schemas.js";

describe("room description input budget", () => {
	it("accepts the same exact length limit on create and settings", () => {
		const description = "x".repeat(5000);
		expect(
			OttApiRequestRoomCreateSchema.safeParse({ name: "bounded-room", description }).success,
		).toBe(true);
		expect(RoomSettingsSchema.safeParse({ description }).success).toBe(true);
	});

	it("rejects an oversized create description before it enters room state", () => {
		const description = "x".repeat(5001);
		expect(
			OttApiRequestRoomCreateSchema.safeParse({ name: "bounded-room", description }).success,
		).toBe(false);
		expect(RoomSettingsSchema.safeParse({ description }).success).toBe(false);
	});
});
