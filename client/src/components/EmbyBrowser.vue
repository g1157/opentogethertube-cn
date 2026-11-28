<template>
	<v-dialog v-model="isOpen" max-width="1080" scrollable>
		<v-card class="emby-card" data-cy="emby-dialog">
			<v-card-title class="d-flex align-center">
				<v-icon :icon="mdiServerNetwork" class="mr-2" />
				<span>{{ t("emby-browser.title") }}</span>
				<v-spacer />
				<v-btn
					icon
					variant="text"
					:aria-label="t('emby-browser.close')"
					data-cy="emby-close"
					@click="isOpen = false"
				>
					<v-icon :icon="mdiClose" />
				</v-btn>
			</v-card-title>
			<v-divider />
			<v-card-text>
				<v-alert
					v-if="error"
					type="error"
					variant="tonal"
					class="mb-3"
					data-cy="emby-error"
				>
					{{ error }}
				</v-alert>

				<v-form v-if="!connected" data-cy="emby-connect-form" @submit.prevent="connect">
					<p class="emby-help">{{ t("emby-browser.help") }}</p>
					<v-text-field
						v-model="serverInput"
						:label="t('emby-browser.server')"
						:placeholder="t('emby-browser.server-placeholder')"
						autocomplete="url"
						inputmode="url"
						variant="outlined"
						density="comfortable"
						data-cy="emby-server"
					/>
					<div class="emby-credentials">
						<v-text-field
							v-model="usernameInput"
							:label="t('emby-browser.username')"
							autocomplete="username"
							variant="outlined"
							density="comfortable"
							data-cy="emby-username"
						/>
						<v-text-field
							v-model="passwordInput"
							:label="t('emby-browser.password')"
							type="password"
							autocomplete="current-password"
							variant="outlined"
							density="comfortable"
							data-cy="emby-password"
						/>
					</div>
					<div class="emby-connect-actions">
						<v-btn
							type="submit"
							color="primary"
							:loading="connecting"
							data-cy="emby-connect"
						>
							{{
								connecting
									? t("emby-browser.connecting")
									: t("emby-browser.connect")
							}}
						</v-btn>
					</div>
					<p class="emby-note">{{ t("emby-browser.privacy") }}</p>
				</v-form>

				<template v-else>
					<div class="emby-account">
						<span class="emby-account-name">
							<v-icon :icon="mdiAccountCircle" size="18" class="mr-1" />
							{{ userName }} · {{ serverName }}
						</span>
						<v-btn
							size="small"
							variant="text"
							data-cy="emby-disconnect"
							@click="disconnect"
						>
							{{ t("emby-browser.disconnect") }}
						</v-btn>
					</div>

					<div class="emby-toolbar">
						<v-select
							v-model="selectedView"
							:items="views"
							item-title="Name"
							item-value="Id"
							:label="t('emby-browser.library')"
							density="comfortable"
							variant="outlined"
							hide-details
							:disabled="views.length === 0"
							data-cy="emby-library"
							@update:model-value="reload"
						/>
						<v-text-field
							v-model="search"
							:label="t('emby-browser.search')"
							:placeholder="t('emby-browser.search-placeholder')"
							density="comfortable"
							variant="outlined"
							hide-details
							clearable
							data-cy="emby-search"
							@keydown.enter.prevent="reload"
							@click:append-inner="reload"
							@click:clear="reload"
						>
							<template #append-inner>
								<v-icon :icon="mdiMagnify" />
							</template>
						</v-text-field>
					</div>

					<div v-if="loading" class="emby-status" data-cy="emby-loading">
						<v-progress-circular indeterminate size="28" />
						<span>{{ t("emby-browser.loading") }}</span>
					</div>
					<p v-else-if="items.length === 0" class="emby-status" data-cy="emby-empty">
						{{ t("emby-browser.empty") }}
					</p>
					<div v-else class="emby-grid" data-cy="emby-grid">
						<button
							v-for="item in items"
							:key="item.Id"
							type="button"
							class="emby-tile"
							:class="{ selected: selected?.Id === item.Id }"
							:data-cy="`emby-item-${item.Id}`"
							@click="select(item)"
						>
							<v-img
								v-if="poster(item)"
								:src="poster(item)"
								aspect-ratio="2/3"
								cover
								class="emby-poster"
							/>
							<div v-else class="emby-poster emby-poster-empty">
								<v-icon :icon="mdiMovieOpenOutline" size="34" />
							</div>
							<span class="emby-name">{{ item.Name }}</span>
							<span class="emby-meta">{{ itemMeta(item) }}</span>
						</button>
					</div>

					<div v-if="items.length > 0 && items.length < total" class="emby-more">
						<v-btn variant="tonal" :loading="loadingMore" @click="loadMore">
							{{ t("emby-browser.load-more") }}
						</v-btn>
					</div>

					<v-divider class="my-4" />

					<div v-if="selected" class="emby-selected" data-cy="emby-selected">
						<div class="emby-selected-info">
							<strong>{{ selected.Name }}</strong>
							<span class="emby-meta">{{ itemMeta(selected) }}</span>
							<span v-if="preparing" class="emby-meta">{{
								t("emby-browser.preparing")
							}}</span>
							<span
								v-else-if="selectedReason"
								class="emby-unsupported"
								data-cy="emby-unsupported"
							>
								{{ t("emby-browser.unsupported", { container: selectedReason }) }}
							</span>
						</div>
						<div class="emby-selected-actions">
							<v-btn
								variant="tonal"
								:disabled="preparing || !selectedSource || busy"
								:prepend-icon="mdiPlaylistPlus"
								data-cy="emby-add"
								@click="add(false)"
							>
								{{ t("emby-browser.add") }}
							</v-btn>
							<v-btn
								color="primary"
								:disabled="preparing || !selectedSource || busy"
								:loading="busy && playNowRequested"
								:prepend-icon="mdiPlay"
								data-cy="emby-play-now"
								@click="add(true)"
							>
								{{ t("emby-browser.play-now") }}
							</v-btn>
						</div>
					</div>
					<p v-else-if="!loading" class="emby-hint">
						{{ t("emby-browser.select-hint") }}
					</p>
					<p class="emby-note">{{ t("emby-browser.note") }}</p>
				</template>
			</v-card-text>
		</v-card>
	</v-dialog>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
	mdiAccountCircle,
	mdiClose,
	mdiMagnify,
	mdiMovieOpenOutline,
	mdiPlay,
	mdiPlaylistPlus,
	mdiServerNetwork,
} from "@mdi/js";
import type { VideoAdd } from "ott-common/models/video.js";
import { API } from "@/common-http";
import { serverErrorMessage } from "@/util/server-error";
import { useStore } from "@/store";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import {
	EMBY_SERVER_STORAGE_KEY,
	EMBY_USERNAME_STORAGE_KEY,
	EmbyError,
	authenticateEmby,
	embyDeviceId,
	embyItemImageUrl,
	embyItemToVideoAdd,
	formatEmbyRuntime,
	getEmbyPlaybackInfo,
	getEmbyServerName,
	getEmbyViews,
	listEmbyItems,
	normalizeEmbyServer,
	pickPlayableEmbySource,
	rememberEmbyServer,
	rememberEmbyUsername,
	type EmbyItem,
	type EmbyView,
	type PlayableEmbySource,
} from "@/util/emby";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
	"update:modelValue": [value: boolean];
	"added": [video: VideoAdd];
}>();

const { t } = useI18n();
const store = useStore();
const roomapi = useRoomApi(useConnection());

const isOpen = computed({
	get: () => props.modelValue,
	// biome-ignore lint/nursery/noVueRefAsOperand: the setter receives a plain boolean, not a ref.
	set: next => emit("update:modelValue", next),
});

function storedValue(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

const serverInput = ref(storedValue(EMBY_SERVER_STORAGE_KEY));
const usernameInput = ref(storedValue(EMBY_USERNAME_STORAGE_KEY));
const passwordInput = ref("");

const server = ref("");
const serverName = ref("");
const userName = ref("");
const token = ref("");
const userId = ref("");
const connected = ref(false);
const connecting = ref(false);
const error = ref("");

const views = ref<EmbyView[]>([]);
const selectedView = ref("");
const search = ref("");
const items = ref<EmbyItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loadingMore = ref(false);

const selected = ref<EmbyItem>();
const selectedSource = ref<PlayableEmbySource>();
const selectedReason = ref("");
const preparing = ref(false);
const busy = ref(false);
const playNowRequested = ref(false);

let listGeneration = 0;
let prepareGeneration = 0;

function describeError(value: unknown): string {
	if (value instanceof EmbyError) {
		switch (value.kind) {
			case "invalid":
				return t("emby-browser.errors.invalid-server");
			case "unauthorized":
				return t("emby-browser.errors.unauthorized");
			case "timeout":
				return t("emby-browser.errors.timeout");
			case "network":
				return t("emby-browser.errors.network");
			case "http":
				return value.status === 403
					? t("emby-browser.errors.forbidden")
					: t("emby-browser.errors.http", { status: value.status ?? "?" });
			case "unsupported":
				return t("emby-browser.errors.unsupported");
		}
	}
	return t("emby-browser.errors.unknown");
}

function resetLibrary(): void {
	listGeneration++;
	prepareGeneration++;
	preparing.value = false;
	items.value = [];
	total.value = 0;
	selected.value = undefined;
	selectedSource.value = undefined;
	selectedReason.value = "";
}

async function load(append: boolean): Promise<void> {
	if (!connected.value) {
		return;
	}
	const generation = ++listGeneration;
	if (append) {
		loadingMore.value = true;
	} else {
		loading.value = true;
	}
	error.value = "";
	try {
		const result = await listEmbyItems(server.value, token.value, userId.value, {
			parentId: selectedView.value || undefined,
			search: search.value,
			startIndex: append ? items.value.length : 0,
		});
		if (generation !== listGeneration) {
			return;
		}
		items.value = append ? [...items.value, ...result.items] : result.items;
		total.value = result.total;
	} catch (value) {
		if (generation === listGeneration) {
			console.error("Emby item request failed:", value);
			error.value = describeError(value);
		}
	} finally {
		if (generation === listGeneration) {
			loading.value = false;
			loadingMore.value = false;
		}
	}
}

function reload(): void {
	resetLibrary();
	void load(false);
}

function loadMore(): void {
	void load(true);
}

async function connect(): Promise<void> {
	if (connecting.value) {
		return;
	}
	error.value = "";
	connecting.value = true;
	try {
		const normalized = normalizeEmbyServer(serverInput.value);
		const parsed = new URL(normalized);
		const loopback =
			parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "[::1]";
		if (window.location.protocol === "https:" && parsed.protocol === "http:" && !loopback) {
			error.value = t("emby-browser.errors.mixed-content");
			return;
		}
		const deviceId = embyDeviceId();
		const auth = await authenticateEmby(
			normalized,
			usernameInput.value.trim(),
			passwordInput.value,
			deviceId,
		);
		const name = await getEmbyServerName(normalized);
		server.value = normalized;
		token.value = auth.token;
		userId.value = auth.userId;
		userName.value = auth.userName;
		serverName.value = name;
		rememberEmbyServer(normalized);
		rememberEmbyUsername(usernameInput.value.trim());
		// Credentials stay in this component; only the server and user name are remembered.
		passwordInput.value = "";
		connected.value = true;
		views.value = await getEmbyViews(normalized, auth.token, auth.userId);
		selectedView.value = views.value[0]?.Id ?? "";
		resetLibrary();
		await load(false);
	} catch (value) {
		console.error("Emby connection failed:", value);
		error.value = describeError(value);
		connected.value = false;
	} finally {
		connecting.value = false;
	}
}

function disconnect(): void {
	connected.value = false;
	token.value = "";
	userId.value = "";
	userName.value = "";
	serverName.value = "";
	views.value = [];
	selectedView.value = "";
	search.value = "";
	resetLibrary();
}

function poster(item: EmbyItem): string | undefined {
	if (!connected.value) {
		return undefined;
	}
	return embyItemImageUrl(server.value, token.value, item);
}

function itemMeta(item: EmbyItem): string {
	const parts: string[] = [];
	if (typeof item.ProductionYear === "number") {
		parts.push(String(item.ProductionYear));
	}
	const runtime = formatEmbyRuntime(item.RunTimeTicks);
	if (runtime !== "") {
		parts.push(runtime);
	}
	return parts.join(" · ");
}

async function select(item: EmbyItem): Promise<void> {
	if (selected.value?.Id === item.Id) {
		return;
	}
	selected.value = item;
	selectedSource.value = undefined;
	selectedReason.value = "";
	preparing.value = true;
	const generation = ++prepareGeneration;
	try {
		const playback = await getEmbyPlaybackInfo(
			server.value,
			token.value,
			userId.value,
			item.Id,
		);
		if (generation !== prepareGeneration) {
			return;
		}
		const result = pickPlayableEmbySource(server.value, playback, item);
		if (result.source) {
			selectedSource.value = result.source;
		} else {
			selectedReason.value = result.reason ?? "unknown";
		}
	} catch (value) {
		if (generation === prepareGeneration) {
			console.error("Emby playback info failed:", value);
			error.value = describeError(value);
		}
	} finally {
		if (generation === prepareGeneration) {
			preparing.value = false;
		}
	}
}

async function add(playNow: boolean): Promise<void> {
	const item = selected.value;
	const source = selectedSource.value;
	if (!item || !source || busy.value) {
		return;
	}
	busy.value = true;
	playNowRequested.value = playNow;
	error.value = "";
	try {
		const video = embyItemToVideoAdd({
			server: server.value,
			serverName: serverName.value,
			token: token.value,
			item,
			source,
		});
		if (playNow) {
			roomapi.playNow(video);
		} else {
			await API.post(`/room/${store.state.room.name}/queue`, video);
		}
		toast.add({
			style: ToastStyle.Success,
			content: t(playNow ? "emby-browser.play-requested" : "emby-browser.added"),
			duration: 3000,
		});
		emit("added", video);
		selected.value = undefined;
		selectedSource.value = undefined;
	} catch (value) {
		console.error("Could not add the Emby item:", value);
		const responseError = (
			value as { response?: { data?: { error?: { name?: unknown; message?: unknown } } } }
		).response?.data?.error;
		error.value =
			responseError !== undefined ? serverErrorMessage(responseError) : describeError(value);
	} finally {
		busy.value = false;
		playNowRequested.value = false;
	}
}

// Opening the dialog for a second time reuses the in-memory session. A page reload
// forgets it on purpose: the token never goes to localStorage.
watch(
	() => props.modelValue,
	open => {
		if (!open) {
			return;
		}
		error.value = "";
	},
);
</script>

<style scoped>
.emby-card {
	display: flex;
	flex-direction: column;
	max-height: 92vh;
}

.emby-help,
.emby-note,
.emby-hint {
	color: rgba(var(--v-theme-on-surface), 0.7);
	font-size: 0.85rem;
	line-height: 1.45;
}

.emby-note {
	margin-top: 12px;
}

.emby-credentials {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.emby-connect-actions {
	display: flex;
	justify-content: flex-end;
}

.emby-account {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 6px 12px;
	border: 1px solid rgba(var(--v-border-color), 0.24);
	border-radius: 8px;
	margin-bottom: 12px;
}

.emby-account-name {
	display: inline-flex;
	align-items: center;
	font-size: 0.9rem;
}

.emby-toolbar {
	display: grid;
	grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1.2fr);
	gap: 12px;
	margin-bottom: 16px;
}

.emby-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
	gap: 12px;
}

.emby-tile {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 4px;
	padding: 6px;
	border: 2px solid transparent;
	border-radius: 8px;
	background: transparent;
	color: inherit;
	text-align: left;
	cursor: pointer;
}

.emby-tile:hover,
.emby-tile:focus-visible {
	background: rgba(var(--v-theme-primary), 0.08);
}

.emby-tile.selected {
	border-color: rgb(var(--v-theme-primary));
	background: rgba(var(--v-theme-primary), 0.12);
}

.emby-poster {
	width: 100%;
	border-radius: 6px;
	background: rgba(var(--v-theme-on-surface), 0.06);
	overflow: hidden;
}

.emby-poster-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	aspect-ratio: 2 / 3;
	color: rgba(var(--v-theme-on-surface), 0.45);
}

.emby-name {
	font-size: 0.85rem;
	font-weight: 600;
	line-height: 1.25;
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.emby-meta {
	font-size: 0.75rem;
	color: rgba(var(--v-theme-on-surface), 0.65);
}

.emby-status {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 10px;
	min-height: 180px;
	color: rgba(var(--v-theme-on-surface), 0.7);
}

.emby-more {
	display: flex;
	justify-content: center;
	margin-top: 16px;
}

.emby-selected {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	flex-wrap: wrap;
}

.emby-selected-info {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.emby-selected-actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}

.emby-unsupported {
	color: rgb(var(--v-theme-error));
	font-size: 0.8rem;
	max-width: 44rem;
}

@media (max-width: 640px) {
	.emby-credentials,
	.emby-toolbar {
		grid-template-columns: 1fr;
	}

	.emby-grid {
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: 8px;
	}
}
</style>
