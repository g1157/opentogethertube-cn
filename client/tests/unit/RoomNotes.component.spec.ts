import { describe, expect, it } from "vitest";
import { RoomRequestType } from "ott-common/models/messages";
import { MAX_NOTE_LENGTH, MAX_NOTES_PER_ROOM } from "ott-common/constants";
import RoomNotes from "@/components/RoomNotes.vue";
import { mountComponent } from "./component-test-utils";

function note(id: number, text: string) {
	return {
		id,
		authorName: "Alice",
		text,
		createdAt: "2026-09-13T12:00:00.000Z",
	};
}

function setNotes(store, notes, maxNotes = MAX_NOTES_PER_ROOM, maxLength = MAX_NOTE_LENGTH) {
	store.commit("notes/SET_NOTES", { action: "notes", notes, maxNotes, maxLength });
}

describe("RoomNotes component", () => {
	it("shows the empty state and appends a trimmed note", async () => {
		const { wrapper, store, connection } = mountComponent(RoomNotes);
		setNotes(store, []);
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-cy="notes-empty"]').exists()).toBe(true);

		await wrapper.get('[data-cy="note-input"] textarea').setValue("  今晚看什么  ");
		await wrapper.get('[data-cy="note-add"]').trigger("click");

		expect(connection.sent).toEqual([
			{
				action: "req",
				request: { type: RoomRequestType.AddNoteRequest, text: "今晚看什么" },
			},
		]);
	});

	it("renders note text as plain text and deletes a note", async () => {
		const { wrapper, store, connection } = mountComponent(RoomNotes);
		setNotes(store, [note(1, "<b>hello</b>")]);
		await wrapper.vm.$nextTick();

		expect(wrapper.get('[data-cy="note-1"]').text()).toContain("<b>hello</b>");
		// A note is the project's first free-text surface; it must never render as markup.
		expect(wrapper.find('[data-cy="note-1"] b').exists()).toBe(false);

		await wrapper.get('[data-cy="note-delete-1"]').trigger("click");
		expect(connection.sent).toEqual([
			{
				action: "req",
				request: { type: RoomRequestType.DeleteNoteRequest, noteId: 1 },
			},
		]);
	});

	it("refuses to add another note once the room is full", async () => {
		const { wrapper, store } = mountComponent(RoomNotes);
		setNotes(store, [note(1, "first"), note(2, "second")], 2);
		await wrapper.vm.$nextTick();

		await wrapper.get('[data-cy="note-input"] textarea').setValue("more");
		const button = wrapper.get('[data-cy="note-add"]').element as HTMLButtonElement;

		expect(button.disabled).toBe(true);
		expect(wrapper.text()).toContain("便签数量已达上限");
	});
});
