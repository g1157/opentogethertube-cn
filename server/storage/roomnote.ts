import { RoomNote as DbRoomNoteModel } from "../models/index.js";
import { getLogger } from "../logger.js";
import type { RoomNote } from "ott-common/models/messages.js";

const log = getLogger("storage/roomnote");

/** Notes are append-only, so the list is simply ordered by insertion. */
export async function listNotes(roomName: string): Promise<RoomNote[]> {
	const notes = await DbRoomNoteModel.findAll({
		where: { roomName },
		order: [["id", "ASC"]],
	});
	return notes.map(note => note.toShared());
}

export async function countNotes(roomName: string): Promise<number> {
	return DbRoomNoteModel.count({ where: { roomName } });
}

export async function addNote(
	roomName: string,
	authorName: string,
	authorId: string,
	text: string,
): Promise<RoomNote> {
	const note = await DbRoomNoteModel.create({
		roomName,
		authorName,
		authorId,
		text,
	});
	log.info(`Added note ${note.id} to room ${roomName}`);
	return note.toShared();
}

export async function deleteNote(roomName: string, noteId: number): Promise<boolean> {
	const deleted = await DbRoomNoteModel.destroy({ where: { roomName, id: noteId } });
	if (deleted > 0) {
		log.info(`Deleted note ${noteId} from room ${roomName}`);
	}
	return deleted > 0;
}

export async function deleteAllNotes(roomName: string): Promise<void> {
	const deleted = await DbRoomNoteModel.destroy({ where: { roomName } });
	if (deleted > 0) {
		log.info(`Deleted ${deleted} note(s) with room ${roomName}`);
	}
}
