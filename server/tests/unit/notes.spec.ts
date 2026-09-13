import { beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import { MAX_NOTES_PER_ROOM, MAX_NOTE_LENGTH } from "ott-common/constants.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";
import storage from "../../storage.js";
import permissions, { PERMISSIONS } from "ott-common/permissions.js";

const NOTE = {
	id: 1,
	authorName: "tester",
	text: "hello",
	createdAt: "2026-09-13T12:00:00.000Z",
};

const TOO_LONG = /limited to/;
const ROOM_FULL = /maximum/;
const TEMPORARY_ROOM = /permanent rooms/;
const PERMISSION_DENIED = /Permission denied/;
const NOTE_MISSING = /no longer exists/;

describe("notes permission and protocol", () => {
	it("keeps the notes permission at its own bit and grants it to everyone by default", () => {
		const notes = PERMISSIONS.find(p => p.name === "configure-room.set-notes");
		expect(notes).toBeDefined();
		expect(notes!.mask).toBe(1 << 27);
		// A colliding mask would silently grant unrelated permissions.
		const collisions = PERMISSIONS.filter(p => p !== notes && p.mask === notes!.mask);
		expect(collisions).toEqual([]);

		const grants = new permissions.Grants();
		expect(grants.granted(Role.UnregisteredUser, "configure-room.set-notes")).toBe(true);
		// Inheritance is what makes granting the lowest role enough.
		expect(grants.granted(Role.Administrator, "configure-room.set-notes")).toBe(true);
	});

	it("does not move any existing permission bit", () => {
		const masks = Object.fromEntries(PERMISSIONS.map(p => [p.name, p.mask]));
		expect(masks["playback.play-pause"]).toBe(1 << 0);
		expect(masks["manage-queue.edit"]).toBe(1 << 26);
	});

	it("appends the new request types after every existing one", () => {
		expect(RoomRequestType.AddNoteRequest).toBe(
			RoomRequestType.TemporaryPlaybackSpeedRequest + 1,
		);
		expect(RoomRequestType.DeleteNoteRequest).toBe(RoomRequestType.AddNoteRequest + 1);
	});
});

describe("room notes", () => {
	let room: Room;

	beforeEach(() => {
		room = new Room({ name: "test", isTemporary: false });
		const user = new RoomUser("user", "a");
		user.unregisteredUsername = "tester";
		room.realusers = [user];
		room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(["*"]));
		vi.spyOn(storage, "listNotes").mockResolvedValue([NOTE]);
		vi.spyOn(storage, "countNotes").mockResolvedValue(0);
		vi.spyOn(storage, "addNote").mockResolvedValue(NOTE);
		vi.spyOn(storage, "deleteNote").mockResolvedValue(true);
	});

	it("appends trimmed text and broadcasts the complete list with its limits", async () => {
		const publish = vi.spyOn(room, "publish").mockResolvedValue(undefined);

		await room.processRequest(
			{ type: RoomRequestType.AddNoteRequest, text: "  hello  " },
			{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
		);

		expect(storage.addNote).toHaveBeenCalledWith("test", "tester", "user", "hello");
		expect(publish).toHaveBeenCalledWith({
			action: "notes",
			notes: [NOTE],
			maxNotes: MAX_NOTES_PER_ROOM,
			maxLength: MAX_NOTE_LENGTH,
		});
	});

	it("ignores an empty note instead of storing whitespace", async () => {
		const publish = vi.spyOn(room, "publish").mockResolvedValue(undefined);

		await room.processRequest(
			{ type: RoomRequestType.AddNoteRequest, text: "   " },
			{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
		);

		expect(storage.addNote).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it("rejects a note longer than the limit", async () => {
		await expect(
			room.processRequest(
				{ type: RoomRequestType.AddNoteRequest, text: "x".repeat(MAX_NOTE_LENGTH + 1) },
				{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
			),
		).rejects.toThrow(TOO_LONG);
		expect(storage.addNote).not.toHaveBeenCalled();
	});

	it("rejects a note once the room is full", async () => {
		vi.mocked(storage.countNotes).mockResolvedValue(MAX_NOTES_PER_ROOM);

		await expect(
			room.processRequest(
				{ type: RoomRequestType.AddNoteRequest, text: "hello" },
				{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
			),
		).rejects.toThrow(ROOM_FULL);
		expect(storage.addNote).not.toHaveBeenCalled();
	});

	it("refuses notes in temporary rooms", async () => {
		const temporary = new Room({ name: "temp", isTemporary: true });

		await expect(
			temporary.processRequest(
				{ type: RoomRequestType.AddNoteRequest, text: "hello" },
				{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
			),
		).rejects.toThrow(TEMPORARY_ROOM);
		expect(storage.addNote).not.toHaveBeenCalled();
	});

	it("requires the notes permission", async () => {
		room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(["chat"]));

		await expect(
			room.processRequest(
				{ type: RoomRequestType.AddNoteRequest, text: "hello" },
				{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
			),
		).rejects.toThrow(PERMISSION_DENIED);
	});

	it("deletes a note and republishes the list", async () => {
		const publish = vi.spyOn(room, "publish").mockResolvedValue(undefined);

		await room.processRequest(
			{ type: RoomRequestType.DeleteNoteRequest, noteId: 1 },
			{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
		);

		expect(storage.deleteNote).toHaveBeenCalledWith("test", 1);
		expect(publish).toHaveBeenCalled();
	});

	it("reports a missing note instead of silently succeeding", async () => {
		vi.mocked(storage.deleteNote).mockResolvedValue(false);

		await expect(
			room.processRequest(
				{ type: RoomRequestType.DeleteNoteRequest, noteId: 42 },
				{ username: "tester", role: Role.UnregisteredUser, clientId: "user" },
			),
		).rejects.toThrow(NOTE_MISSING);
	});
});
