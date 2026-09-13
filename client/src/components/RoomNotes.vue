<template>
	<div class="room-notes">
		<div class="notes-compose">
			<v-textarea
				v-model="draft"
				:label="$t('room-notes.input-label')"
				:placeholder="$t('room-notes.placeholder')"
				:hint="composeHint"
				:maxlength="maxLength"
				:counter="maxLength"
				:rows="2"
				auto-grow
				variant="outlined"
				density="compact"
				persistent-hint
				:disabled="isFull"
				data-cy="note-input"
			/>
			<div class="notes-compose-actions">
				<span class="notes-count">{{
					$t("room-notes.counter", { count: notes.length, max: maxNotes })
				}}</span>
				<v-btn color="primary" :disabled="!canSubmit" data-cy="note-add" @click="submit">{{
					$t("room-notes.add")
				}}</v-btn>
			</div>
		</div>

		<p v-if="notes.length === 0" class="notes-empty" data-cy="notes-empty">
			{{ $t("room-notes.empty") }}
		</p>
		<ul v-else class="notes-list">
			<li v-for="note in notes" :key="note.id" class="note" :data-cy="`note-${note.id}`">
				<p class="note-text">{{ note.text }}</p>
				<div class="note-meta">
					<span class="note-author">{{ note.authorName }}</span>
					<span class="note-time">{{ noteTime(note.createdAt) }}</span>
					<v-btn
						icon
						size="x-small"
						variant="text"
						:aria-label="$t('room-notes.delete-label')"
						:data-cy="`note-delete-${note.id}`"
						@click="remove(note.id)"
					>
						<v-icon :icon="mdiTrashCanOutline" />
					</v-btn>
				</div>
			</li>
		</ul>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { mdiTrashCanOutline } from "@mdi/js";
import { useStore } from "@/store";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";

const store = useStore();
const { t } = useI18n();
const roomapi = useRoomApi(useConnection());

const draft = ref("");
const notes = computed(() => store.state.notes.notes);
const maxNotes = computed(() => store.state.notes.maxNotes);
const maxLength = computed(() => store.state.notes.maxLength);
const isFull = computed(() => notes.value.length >= maxNotes.value);
const canSubmit = computed(() => !isFull.value && draft.value.trim().length > 0);
const composeHint = computed(() =>
	isFull.value ? t("room-notes.full") : t("room-notes.input-hint"),
);

function submit() {
	if (!canSubmit.value) {
		return;
	}
	roomapi.addNote(draft.value.trim());
	draft.value = "";
}

function remove(noteId: number) {
	roomapi.deleteNote(noteId);
}

function noteTime(createdAt: string): string {
	const date = new Date(createdAt);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleString(document.documentElement.lang || undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
</script>

<style lang="scss" scoped>
.room-notes {
	padding: 16px;
}

.notes-compose-actions {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-top: 8px;
}

.notes-count {
	color: var(--muted-foreground);
	font-family: var(--font-mono);
	font-size: 0.75rem;
}

.notes-empty {
	padding: 24px 0;
	color: var(--muted-foreground);
	text-align: center;
}

.notes-list {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin: 16px 0 0;
	padding: 0;
	list-style: none;
}

.note {
	display: flex;
	flex-direction: column;
	gap: 6px;
	border: 1px solid var(--line);
	border-radius: 8px;
	padding: 10px 12px;
	background: var(--card);
}

.note-text {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	line-height: 1.55;
	color: var(--foreground);
}

// Signature line sits at the bottom right and stays visually quieter than the note itself.
.note-meta {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	color: var(--muted-foreground);
	font-family: var(--font-mono);
	font-size: 0.7rem;
	letter-spacing: 0.02em;
}

.note-author {
	max-width: 60%;
	font-style: italic;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.note-time {
	font-variant-numeric: tabular-nums;
}

.note-meta .v-btn {
	margin-left: 2px;
}
</style>
