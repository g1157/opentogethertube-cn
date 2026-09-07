<template>
	<section class="my-rooms" :aria-busy="isLoading">
		<PageHeader
			:eyebrow="$t('my-rooms.owned-eyebrow')"
			:title="$t('nav.my-rooms')"
			:description="$t('nav.create.perm-desc')"
		>
			<v-btn
				v-if="rooms.length > 0"
				color="primary"
				variant="flat"
				:prepend-icon="mdiPlus"
				:loading="isCreating"
				@click="createTempRoom"
			>
				{{ $t("room-list.create") }}
			</v-btn>
		</PageHeader>

		<div v-if="isLoading" class="list-state" role="status">
			<v-progress-circular color="primary" indeterminate :size="36" />
			<p>{{ $t("common.loading") }}</p>
		</div>
		<div v-else-if="loadFailed" class="list-state" role="alert" data-cy="rooms-load-error">
			<v-icon :icon="mdiAlertCircleOutline" :size="36" aria-hidden="true" />
			<p>{{ $t("room-list.load-failed") }}</p>
			<v-btn color="primary" variant="outlined" :prepend-icon="mdiRefresh" @click="loadRooms">
				{{ $t("common.retry") }}
			</v-btn>
		</div>
		<div v-else-if="rooms.length === 0" class="list-state" data-cy="rooms-empty">
			<span class="state-eyebrow">{{ $t("room-list.empty-eyebrow") }}</span>
			<h2>{{ $t("my-rooms.no-rooms") }}</h2>
			<v-btn
				color="primary"
				size="large"
				variant="flat"
				:prepend-icon="mdiPlus"
				:loading="isCreating"
				@click="createTempRoom"
			>
				{{ $t("room-list.create") }}
			</v-btn>
		</div>
		<ul v-else class="owned-room-list">
			<li v-for="room in rooms" :key="room.name" class="owned-room">
				<router-link
					class="room-entry"
					:to="'/room/' + encodeURIComponent(room.name)"
					data-cy="owned-room-entry"
				>
					<div class="room-meta">
						<span class="room-type" :class="{ permanent: !room.isTemporary }">
							{{
								room.isTemporary
									? $t("room.title-temp")
									: $t("room-list.permanent-room")
							}}
						</span>
					</div>
					<h2 class="room-title">{{ room.title?.trim() || room.name }}</h2>
					<p v-if="room.title && room.title !== room.name" class="room-id">
						{{ room.name }}
					</p>
					<p class="room-description">
						{{ room.description || $t("room-list.no-description") }}
					</p>
				</router-link>
				<div class="room-actions">
					<v-btn
						v-if="!room.isTemporary"
						:icon="mdiDeleteOutline"
						variant="text"
						color="error"
						:disabled="isDeleting"
						:aria-label="$t('my-rooms.delete-label', { name: room.title || room.name })"
						:title="$t('my-rooms.delete-label', { name: room.title || room.name })"
						data-cy="delete-room"
						@click="openDeleteDialog(room)"
					/>
					<router-link
						class="enter-link"
						:to="'/room/' + encodeURIComponent(room.name)"
						:aria-label="$t('room-list.enter') + ': ' + (room.title || room.name)"
					>
						{{ $t("room-list.enter") }}
						<v-icon :icon="mdiArrowRight" :size="18" aria-hidden="true" />
					</router-link>
				</div>
			</li>
		</ul>

		<v-dialog
			v-model="showDeleteDialog"
			:persistent="isDeleting"
			max-width="500"
			aria-labelledby="delete-room-title"
		>
			<v-card>
				<v-card-title id="delete-room-title" class="text-h6">{{
					$t("common.delete")
				}}</v-card-title>
				<v-card-text>
					<p>
						{{ $t("my-rooms.confirm-delete", { name: roomPendingDelete?.name || "" }) }}
					</p>
					<v-alert
						v-if="deleteFailed"
						type="error"
						variant="tonal"
						class="mt-4"
						role="alert"
						data-cy="delete-room-error"
					>
						{{ $t("my-rooms.delete-failed") }}
					</v-alert>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn variant="text" :disabled="isDeleting" @click="closeDeleteDialog">{{
						$t("common.cancel")
					}}</v-btn>
					<v-btn
						color="error"
						variant="flat"
						:loading="isDeleting"
						:disabled="isDeleting"
						data-cy="confirm-delete-room"
						@click="confirmDelete"
					>
						{{ $t("common.delete") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</section>
</template>

<script lang="ts" setup>
import {
	mdiAlertCircleOutline,
	mdiArrowRight,
	mdiDeleteOutline,
	mdiPlus,
	mdiRefresh,
} from "@mdi/js";
import type { OttResponseBody, RoomListItem } from "ott-common/models/rest-api";
import { onMounted, ref } from "vue";
import { API } from "@/common-http";
import PageHeader from "@/components/PageHeader.vue";
import { useStore } from "@/store";
import { createRoomHelper } from "@/util/roomcreator";

const isLoading = ref(false);
const isCreating = ref(false);
const loadFailed = ref(false);
const rooms = ref<RoomListItem[]>([]);
const store = useStore();
const showDeleteDialog = ref(false);
const roomPendingDelete = ref<RoomListItem | null>(null);
const isDeleting = ref(false);
const deleteFailed = ref(false);

onMounted(loadRooms);

async function loadRooms() {
	if (isLoading.value) {
		return;
	}
	isLoading.value = true;
	loadFailed.value = false;
	try {
		const result = await API.get<OttResponseBody<{ data: RoomListItem[] }>>(
			"/user/owned-rooms",
		);
		if (result.data.success !== true || !Array.isArray(result.data.data)) {
			throw new Error("Unable to load owned rooms");
		}
		rooms.value = result.data.data;
	} catch {
		loadFailed.value = true;
	} finally {
		isLoading.value = false;
	}
}

async function createTempRoom() {
	if (isCreating.value) {
		return;
	}
	isCreating.value = true;
	try {
		await createRoomHelper(store);
	} catch {
		// The shared helper reports creation failures through the application's toast.
	} finally {
		isCreating.value = false;
	}
}

function openDeleteDialog(room: RoomListItem) {
	if (isDeleting.value || room.isTemporary) {
		return;
	}
	roomPendingDelete.value = room;
	deleteFailed.value = false;
	showDeleteDialog.value = true;
}

function closeDeleteDialog() {
	if (isDeleting.value) {
		return;
	}
	showDeleteDialog.value = false;
	roomPendingDelete.value = null;
	deleteFailed.value = false;
}

async function confirmDelete() {
	const room = roomPendingDelete.value;
	if (!room || isDeleting.value) {
		return;
	}
	isDeleting.value = true;
	deleteFailed.value = false;
	try {
		const response = await API.delete<OttResponseBody>(
			"/room/" + encodeURIComponent(room.name),
			{ params: { permanent: true } },
		);
		if (response.data.success !== true) {
			deleteFailed.value = true;
			return;
		}
		rooms.value = rooms.value.filter(item => item.name !== room.name);
		showDeleteDialog.value = false;
		roomPendingDelete.value = null;
	} catch {
		deleteFailed.value = true;
	} finally {
		isDeleting.value = false;
	}
}
</script>

<style scoped>
.my-rooms {
	width: min(100%, 62rem);
	margin-inline: auto;
	padding: clamp(1.5rem, 4vw, 3rem) clamp(1rem, 3vw, 1.5rem) 3rem;
}
.list-state {
	display: flex;
	min-height: 45vh;
	align-items: center;
	justify-content: center;
	flex-direction: column;
	gap: 1.25rem;
	padding: 2rem 1rem;
	border: 1px dashed var(--line-strong);
	border-radius: 0.75rem;
	color: var(--muted-foreground);
	text-align: center;
}
.list-state h2 {
	color: var(--foreground);
	font-family: var(--font-display);
	font-size: clamp(1.5rem, 4vw, 2rem);
}
.state-eyebrow {
	color: var(--signal);
	font-family: var(--font-mono);
	font-size: 0.75rem;
	letter-spacing: 0.12em;
}
.owned-room-list {
	display: flex;
	flex-direction: column;
	gap: 1rem;
	margin: 0;
	padding: 0;
	list-style: none;
}
.owned-room {
	display: flex;
	min-width: 0;
	border: 1px solid var(--line);
	border-radius: 0.75rem;
	background: var(--card);
	transition: border-color 160ms ease;
}
.owned-room:hover,
.owned-room:focus-within {
	border-color: var(--primary);
}
.room-entry {
	min-width: 0;
	flex: 1;
	border-radius: 0.75rem 0 0 0.75rem;
	padding: 1.25rem;
	color: var(--foreground);
	text-decoration: none;
}
.room-entry:focus-visible,
.enter-link:focus-visible {
	outline: 2px solid var(--primary);
	outline-offset: 3px;
}
.room-meta {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.75rem;
	margin-bottom: 0.65rem;
	font-size: 0.72rem;
}
.room-type {
	border: 1px solid var(--line-strong);
	border-radius: 0.25rem;
	padding: 0.2rem 0.45rem;
	color: var(--muted-foreground);
}
.room-type.permanent {
	color: var(--signal);
}
.room-title {
	font-family: var(--font-display);
	font-size: 1.3rem;
	font-weight: 600;
	line-height: 1.4;
	overflow-wrap: anywhere;
}
.room-id {
	margin-top: 0.2rem;
	color: var(--muted-foreground);
	font-family: var(--font-mono);
	font-size: 0.75rem;
	overflow-wrap: anywhere;
}
.room-description {
	margin-top: 0.5rem;
	overflow: hidden;
	color: var(--muted-foreground);
	font-size: 0.875rem;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.room-actions {
	display: flex;
	width: 9rem;
	align-items: center;
	justify-content: center;
	flex-direction: column;
	gap: 0.75rem;
	border-left: 1px dashed var(--line-strong);
	padding: 1rem;
}
.enter-link {
	display: inline-flex;
	min-height: 44px;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
	color: var(--primary);
	font-size: 0.8rem;
	font-weight: 600;
	text-decoration: none;
	white-space: nowrap;
}
@media (max-width: 600px) {
	.owned-room {
		flex-direction: column;
	}
	.room-entry {
		border-radius: 0.75rem 0.75rem 0 0;
		padding: 1rem;
	}
	.room-actions {
		width: auto;
		justify-content: space-between;
		flex-direction: row;
		border-top: 1px dashed var(--line-strong);
		border-left: 0;
		padding: 0.35rem 1rem;
	}
	.enter-link {
		margin-left: auto;
	}
}
@media (prefers-reduced-motion: reduce) {
	.owned-room {
		transition: none;
	}
}
</style>
