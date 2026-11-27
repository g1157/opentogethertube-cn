<template>
	<section class="room-list" :aria-busy="isLoading || isLoadingMore">
		<PageHeader :eyebrow="$t('room-list.browse-eyebrow')" :title="$t('nav.browse')">
			<v-btn
				v-if="rooms.length > 0"
				color="primary"
				variant="flat"
				:prepend-icon="mdiPlus"
				:loading="isCreating"
				@click="createRoom"
			>
				{{ $t("room-list.create") }}
			</v-btn>
		</PageHeader>

		<div v-if="rooms.length > 0" class="room-controls">
			<label class="room-search">
				<span>{{ $t("room-list.search") }}</span>
				<input v-model="search" type="search" data-cy="rooms-search" />
			</label>
			<label class="room-sort">
				<span>{{ $t("room-list.sort") }}</span>
				<select v-model="sortOrder" data-cy="rooms-sort">
					<option value="default">{{ $t("room-list.sort-default") }}</option>
					<option value="name">{{ $t("room-list.sort-name") }}</option>
					<option value="users">{{ $t("room-list.sort-users") }}</option>
				</select>
			</label>
		</div>

		<div
			v-if="isLoading"
			class="room-grid"
			role="status"
			:aria-label="$t('common.loading')"
			data-cy="rooms-loading"
		>
			<RoomCardSkeleton v-for="n in 6" :key="n" />
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
			<h2>{{ $t("room-list.no-rooms") }}</h2>
			<v-btn
				color="primary"
				size="large"
				variant="flat"
				:prepend-icon="mdiPlus"
				:loading="isCreating"
				@click="createRoom"
			>
				{{ $t("room-list.create") }}
			</v-btn>
		</div>
		<div
			v-else-if="displayRooms.length === 0"
			class="list-state"
			role="status"
			data-cy="rooms-no-match"
		>
			<p>{{ $t("room-list.no-match") }}</p>
		</div>
		<ul v-else class="room-grid">
			<li v-for="room in displayRooms" :key="room.name">
				<router-link
					class="room-ticket"
					:to="'/room/' + encodeURIComponent(room.name)"
					data-cy="room-card"
				>
					<v-img
						class="room-thumbnail"
						:src="room.currentSource?.thumbnail || placeholderUrl"
						:aspect-ratio="1.8"
						alt=""
						cover
					>
						<template #error>
							<v-img :src="placeholderUrl" :aspect-ratio="1.8" alt="" cover />
						</template>
					</v-img>
					<div class="room-details">
						<div class="room-meta">
							<span class="room-type" :class="{ permanent: !room.isTemporary }">
								{{
									room.isTemporary
										? $t("room.title-temp")
										: $t("room-list.permanent-room")
								}}
							</span>
							<span class="room-flags">
								<span
									v-if="room.hasPassword"
									class="room-lock"
									data-cy="room-password-badge"
								>
									<v-icon :icon="mdiLockOutline" :size="14" aria-hidden="true" />
									{{ $t("room-list.password-protected") }}
								</span>
								<span class="room-viewers" data-cy="room-viewers">
									<v-icon
										:icon="mdiAccountMultiple"
										:size="16"
										aria-hidden="true"
									/>
									{{ $t("room-list.viewers", { count: room.users }) }}
								</span>
							</span>
						</div>
						<h2 class="room-title">
							{{
								room.title?.trim() ||
								(room.isTemporary ? $t("room.title-temp") : room.name)
							}}
						</h2>
						<p class="room-description">
							{{ room.description || $t("room-list.no-description") }}
						</p>
						<div class="room-video" :class="{ empty: !room.videoTitle }">
							<v-icon :icon="mdiPlayCircleOutline" :size="18" aria-hidden="true" />
							<span :title="room.videoTitle" data-cy="room-video-title">
								{{ room.videoTitle || $t("room-list.nothing-playing") }}
							</span>
						</div>
					</div>
					<div class="ticket-entry">
						<span>{{ $t("room-list.enter") }}</span>
						<v-icon :icon="mdiArrowRight" :size="18" aria-hidden="true" />
					</div>
				</router-link>
			</li>
		</ul>
		<div
			v-if="!isLoading && !loadFailed && rooms.length > 0 && hasMore"
			class="room-pagination"
		>
			<p v-if="loadMoreFailed" role="alert" data-cy="rooms-load-more-error">
				{{ $t("room-list.load-failed") }}
			</p>
			<v-btn
				color="primary"
				variant="outlined"
				:loading="isLoadingMore"
				data-cy="rooms-load-more"
				@click="loadMoreRooms"
			>
				{{ $t(loadMoreFailed ? "common.retry" : "room-list.load-more") }}
			</v-btn>
		</div>
	</section>
</template>

<script lang="ts" setup>
import {
	mdiAccountMultiple,
	mdiAlertCircleOutline,
	mdiArrowRight,
	mdiLockOutline,
	mdiPlayCircleOutline,
	mdiPlus,
	mdiRefresh,
} from "@mdi/js";
import type { RoomListItem } from "ott-common/models/rest-api";
import { computed, onMounted, ref } from "vue";
import { API } from "@/common-http";
import PageHeader from "@/components/PageHeader.vue";
import RoomCardSkeleton from "@/components/RoomCardSkeleton.vue";
import { useStore } from "@/store";
import { nowPlayingDetails } from "@/util/now-playing";
import { createRoomHelper } from "@/util/roomcreator";
import placeholderUrl from "@/assets/placeholder.svg";

const isLoading = ref(false);
const isCreating = ref(false);
const loadFailed = ref(false);
const isLoadingMore = ref(false);
const loadMoreFailed = ref(false);
const hasMore = ref(false);
const nextOffset = ref(0);
const search = ref("");
const sortOrder = ref("default");
const PAGE_SIZE = 24;
const rooms = ref<RoomListItem[]>([]);
const store = useStore();
const displayRooms = computed(() => {
	const query = search.value.trim().toLocaleLowerCase();
	const filtered = rooms.value.filter(
		room =>
			!query ||
			room.name.toLocaleLowerCase().includes(query) ||
			room.title?.toLocaleLowerCase().includes(query),
	);
	if (sortOrder.value !== "default") {
		filtered.sort(
			(a, b) =>
				(sortOrder.value === "users" ? b.users - a.users : 0) ||
				a.name.localeCompare(b.name),
		);
	}
	return filtered.map(toRoomCard);
});

function toRoomCard(room: RoomListItem) {
	return { ...room, videoTitle: nowPlayingDetails(room.currentSource).title };
}

onMounted(loadRooms);

async function loadRooms() {
	if (isLoading.value) {
		return;
	}
	isLoading.value = true;
	loadFailed.value = false;
	try {
		const result = await API.get<RoomListItem[]>("/room/list", {
			params: { limit: PAGE_SIZE, offset: 0 },
		});
		if (!Array.isArray(result.data)) {
			throw new Error("Invalid room list response");
		}
		rooms.value = result.data;
		nextOffset.value = result.data.length;
		hasMore.value = result.data.length >= PAGE_SIZE;
		loadMoreFailed.value = false;
	} catch {
		loadFailed.value = true;
	} finally {
		isLoading.value = false;
	}
}

async function loadMoreRooms() {
	if (isLoading.value || isLoadingMore.value || !hasMore.value) return;
	isLoadingMore.value = true;
	loadMoreFailed.value = false;
	try {
		const result = await API.get<RoomListItem[]>("/room/list", {
			params: { limit: PAGE_SIZE, offset: nextOffset.value },
		});
		if (!Array.isArray(result.data)) throw new Error("Invalid room list response");
		const merged = new Map(rooms.value.map(room => [room.name.toLowerCase(), room]));
		for (const room of result.data) merged.set(room.name.toLowerCase(), room);
		rooms.value = [...merged.values()];
		nextOffset.value += result.data.length;
		hasMore.value = result.data.length >= PAGE_SIZE;
	} catch {
		loadMoreFailed.value = true;
	} finally {
		isLoadingMore.value = false;
	}
}

async function createRoom() {
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
</script>

<style scoped>
.room-list {
	width: min(100%, 76rem);
	margin-inline: auto;
	padding: clamp(1.5rem, 4vw, 3rem) clamp(1rem, 3vw, 1.5rem) 3rem;
}
.room-controls {
	display: flex;
	flex-wrap: wrap;
	gap: 1rem;
	margin-bottom: 1.5rem;
}
.room-controls label {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	color: var(--muted-foreground);
	font-size: 0.875rem;
}
.room-search {
	flex: 1 1 16rem;
}
.room-sort {
	flex: 1 1 12rem;
}
.room-controls input,
.room-controls select {
	width: 100%;
	min-height: 2.75rem;
	border: 1px solid var(--line-strong);
	border-radius: 0.5rem;
	padding: 0.6rem 0.75rem;
	background: var(--card);
	color: var(--foreground);
}
.room-controls input:focus-visible,
.room-controls select:focus-visible {
	outline: 2px solid var(--primary);
	outline-offset: 2px;
}
.room-pagination {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 1rem;
	margin-top: 1.5rem;
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
.room-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
	gap: 1.25rem;
	margin: 0;
	padding: 0;
	list-style: none;
}
.room-grid > li {
	min-width: 0;
}
.room-ticket {
	display: flex;
	height: 100%;
	flex-direction: column;
	border: 1px solid var(--line);
	border-radius: 0.75rem;
	overflow: hidden;
	background: var(--card);
	color: var(--foreground);
	text-decoration: none;
	transition: border-color 160ms ease, box-shadow 160ms ease;
}
.room-ticket:hover,
.room-ticket:focus-visible {
	border-color: var(--primary);
	box-shadow: 0 5px 20px rgb(0 0 0 / 12%);
}
.room-ticket:focus-visible {
	outline: 2px solid var(--primary);
	outline-offset: 3px;
}
.room-thumbnail {
	flex: none;
	border-bottom: 1px solid var(--line);
	background: var(--background);
}
.room-details {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 0.7rem;
	padding: 1rem;
}
.room-meta {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 0.5rem;
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
.room-flags {
	display: inline-flex;
	align-items: center;
	gap: 0.6rem;
}
.room-lock {
	display: inline-flex;
	align-items: center;
	gap: 0.25rem;
	color: var(--signal);
	white-space: nowrap;
}
.room-viewers {
	display: inline-flex;
	align-items: center;
	gap: 0.35rem;
	color: var(--muted-foreground);
	font-family: var(--font-mono);
	white-space: nowrap;
}
.room-title {
	font-family: var(--font-display);
	font-size: 1.3rem;
	font-weight: 600;
	line-height: 1.4;
	overflow-wrap: anywhere;
}
.room-description {
	display: -webkit-box;
	min-height: 2.8em;
	overflow: hidden;
	color: var(--muted-foreground);
	font-size: 0.875rem;
	line-height: 1.4;
	overflow-wrap: anywhere;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
}
.room-video {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	margin-top: auto;
	padding-top: 0.35rem;
	color: var(--signal);
	font-size: 0.8rem;
}
.room-video > span {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.room-video.empty {
	color: var(--muted-foreground);
}
.ticket-entry {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	border-top: 1px dashed var(--line-strong);
	padding: 0.85rem 1rem;
	color: var(--primary);
	font-size: 0.8rem;
	font-weight: 600;
}
.ticket-entry::before,
.ticket-entry::after {
	position: absolute;
	top: -7px;
	width: 14px;
	height: 14px;
	border: 1px solid var(--line-strong);
	border-radius: 50%;
	background: var(--background);
	content: "";
}
.ticket-entry::before {
	left: -8px;
}
.ticket-entry::after {
	right: -8px;
}
@media (prefers-reduced-motion: reduce) {
	.room-ticket {
		transition: none;
	}
}
</style>
