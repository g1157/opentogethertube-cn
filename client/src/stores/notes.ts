import type { Module } from "vuex";
import type { RoomNote, ServerMessageNotes } from "ott-common/models/messages";
import type { FullOTTStoreState } from "../store";
import { MAX_NOTES_PER_ROOM, MAX_NOTE_LENGTH } from "ott-common/constants";

export interface NotesState {
	notes: RoomNote[];
	maxNotes: number;
	maxLength: number;
}

/**
 * Notes live in the store (not in the panel component) so the tab badge can show the
 * count while the panel is closed.
 */
export const notesModule: Module<NotesState, FullOTTStoreState> = {
	namespaced: true,
	state: {
		notes: [],
		maxNotes: MAX_NOTES_PER_ROOM,
		maxLength: MAX_NOTE_LENGTH,
	},
	mutations: {
		SET_NOTES(state, message: ServerMessageNotes) {
			state.notes = message.notes;
			state.maxNotes = message.maxNotes;
			state.maxLength = message.maxLength;
		},
		/** Leaving a room must not leave its notes visible in the next one. */
		CLEAR(state) {
			state.notes = [];
		},
	},
	actions: {
		notes(context, message: ServerMessageNotes) {
			context.commit("SET_NOTES", message);
		},
	},
};

export default notesModule;
