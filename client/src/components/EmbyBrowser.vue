<template>
	<v-dialog v-model="isOpen" max-width="1200" scrollable>
		<v-card class="emby-card" data-cy="emby-dialog">
			<v-card-title class="emby-header">
				<v-icon :icon="mdiServerNetwork" class="emby-header-icon" />
				<span class="emby-title">{{ t("emby-browser.title") }}</span>
				<v-chip
					v-if="connected"
					size="small"
					variant="tonal"
					class="emby-header-chip"
					data-cy="emby-account-chip"
				>
					{{ userName }} · {{ serverName }}
				</v-chip>
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

			<v-card-text class="emby-body">
				<v-alert
					v-if="error"
					type="error"
					variant="tonal"
					closable
					class="mb-4"
					data-cy="emby-error"
					@click:close="error = ''"
				>
					{{ error }}
				</v-alert>

				<v-form v-if="!connected" data-cy="emby-connect-form" @submit.prevent="connect">
					<p class="emby-help">{{ t("emby-browser.help") }}</p>

					<p class="emby-section-label">{{ t("emby-browser.server") }}</p>
					<div class="emby-server-row">
						<v-select
							v-model="schemeInput"
							:items="schemeOptions"
							item-title="title"
							item-value="value"
							:label="t('emby-browser.server-scheme')"
							variant="outlined"
							density="comfortable"
							hide-details
							data-cy="emby-scheme"
						/>
						<v-text-field
							v-model="hostInput"
							:label="t('emby-browser.server-host')"
							:placeholder="t('emby-browser.server-host-placeholder')"
							autocomplete="url"
							inputmode="url"
							variant="outlined"
							density="comfortable"
							hide-details
							data-cy="emby-host"
							@update:model-value="absorbServerText"
						/>
						<v-text-field
							v-model="portInput"
							:label="t('emby-browser.server-port')"
							:placeholder="t('emby-browser.server-port-placeholder')"
							inputmode="numeric"
							variant="outlined"
							density="comfortable"
							hide-details
							data-cy="emby-port"
							@update:model-value="absorbPortText"
						/>
					</div>

					<v-text-field
						v-if="showPath"
						v-model="pathInput"
						:label="t('emby-browser.server-path')"
						:placeholder="t('emby-browser.server-path-placeholder')"
						variant="outlined"
						density="comfortable"
						hide-details
						class="mt-3"
						data-cy="emby-path"
					/>
					<v-btn
						v-else
						variant="text"
						size="small"
						class="emby-path-toggle"
						data-cy="emby-path-toggle"
						@click="showPath = true"
					>
						<v-icon :icon="mdiFolderOutline" start size="16" />
						{{ t("emby-browser.server-add-path") }}
					</v-btn>
					<v-btn
						v-if="showPath && pathInput === ''"
						variant="text"
						size="small"
						class="emby-path-toggle"
						@click="showPath = false"
					>
						{{ t("emby-browser.server-hide-path") }}
					</v-btn>

					<p v-if="hostInput !== ''" class="emby-endpoint" data-cy="emby-endpoint">
						<span class="emby-section-label">{{
							t("emby-browser.server-preview")
						}}</span>
						<code>{{ serverUrl }}</code>
					</p>

					<p class="emby-section-label emby-section-gap">
						{{ t("emby-browser.account-section") }}
					</p>
					<div class="emby-credentials">
						<v-text-field
							v-model="usernameInput"
							:label="t('emby-browser.username')"
							autocomplete="username"
							variant="outlined"
							density="comfortable"
							hide-details
							data-cy="emby-username"
						/>
						<v-text-field
							v-model="passwordInput"
							:label="t('emby-browser.password')"
							:type="showPassword ? 'text' : 'password'"
							autocomplete="current-password"
							variant="outlined"
							density="comfortable"
							hide-details
							data-cy="emby-password"
						>
							<template #append-inner>
								<v-btn
									icon
									variant="text"
									size="x-small"
									tabindex="-1"
									:aria-label="
										t(
											showPassword
												? 'emby-browser.hide-password'
												: 'emby-browser.show-password',
										)
									"
									@click="showPassword = !showPassword"
								>
									<v-icon
										:icon="showPassword ? mdiEyeOffOutline : mdiEyeOutline"
										size="18"
									/>
								</v-btn>
							</template>
						</v-text-field>
					</div>

					<div class="emby-connect-actions">
						<v-btn
							type="submit"
							color="primary"
							size="large"
							class="emby-connect-button"
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
						>
							<template #prepend-inner>
								<v-icon :icon="mdiMagnify" size="20" />
							</template>
						</v-text-field>
					</div>

					<div class="emby-toolbar-meta">
						<span class="emby-count" data-cy="emby-results-count">
							{{ resultsLabel }}
						</span>
						<v-spacer />
						<v-btn
							v-if="search !== ''"
							size="small"
							variant="text"
							data-cy="emby-clear-search"
							@click="clearSearch"
						>
							{{ t("emby-browser.clear-search") }}
						</v-btn>
						<v-btn
							size="small"
							variant="text"
							:prepend-icon="mdiAccountCircle"
							data-cy="emby-disconnect"
							@click="disconnect"
						>
							{{ t("emby-browser.disconnect") }}
						</v-btn>
					</div>

					<div class="emby-layout">
						<div class="emby-main">
							<div
								v-if="seriesContext"
								class="emby-series-bar"
								data-cy="emby-series-bar"
							>
								<v-btn
									size="small"
									variant="tonal"
									:prepend-icon="mdiArrowLeft"
									data-cy="emby-series-back"
									@click="leaveSeries"
								>
									{{ t("emby-browser.back-to-library") }}
								</v-btn>
								<span class="emby-series-name">{{ seriesContext.name }}</span>
							</div>

							<div
								v-if="loading"
								class="emby-grid emby-grid-skeleton"
								data-cy="emby-loading"
							>
								<div v-for="n in 8" :key="n" class="emby-skeleton"></div>
							</div>
							<div
								v-else-if="items.length === 0"
								class="emby-status"
								data-cy="emby-empty"
							>
								<v-icon :icon="mdiMovieOpenOutline" size="28" />
								<p>{{ t("emby-browser.empty") }}</p>
								<v-btn
									variant="tonal"
									size="small"
									data-cy="emby-retry"
									@click="reload"
								>
									{{ t("emby-browser.retry-check") }}
								</v-btn>
							</div>
							<div v-else class="emby-grid" data-cy="emby-grid">
								<button
									v-for="item in items"
									:key="item.Id"
									type="button"
									class="emby-tile"
									:class="[
										tileStatusClass(item),
										{ 'emby-tile-selected': selected?.Id === item.Id },
									]"
									:aria-pressed="selected?.Id === item.Id"
									:data-cy="`emby-item-${item.Id}`"
									@click="select(item)"
								>
									<div class="emby-poster-wrap">
										<v-img
											v-if="poster(item)"
											:src="poster(item)"
											cover
											class="emby-poster"
										/>
										<div v-else class="emby-poster-empty">
											<v-icon :icon="mdiMovieOpenOutline" size="32" />
										</div>
										<v-chip
											v-if="badgeLabel(item) !== ''"
											size="small"
											:color="badgeColor(item)"
											class="emby-tile-badge"
											:class="{
												'emby-badge-unknown':
													summaryFor(item)?.status === 'unknown',
											}"
											variant="flat"
										>
											{{ badgeLabel(item) }}
										</v-chip>
									</div>
									<span v-if="item.SeriesName" class="emby-series">{{
										item.SeriesName
									}}</span>
									<span class="emby-name">{{ item.Name }}</span>
									<span class="emby-meta">{{ itemMeta(item) }}</span>
									<span v-if="summaryFor(item)" class="emby-specs">
										{{ specsFor(item) }}
									</span>
									<span v-else-if="item.Type === 'Series'" class="emby-specs">
										{{ t("emby-browser.open-series") }}
									</span>
								</button>
							</div>

							<div v-if="items.length > 0 && items.length < total" class="emby-more">
								<v-btn variant="tonal" :loading="loadingMore" @click="loadMore">
									{{ t("emby-browser.load-more") }}
								</v-btn>
							</div>
						</div>

						<aside
							class="emby-side"
							:class="{ 'emby-side-pinned': selected !== undefined }"
						>
							<section v-if="selected" class="emby-panel" data-cy="emby-selected">
								<div class="emby-panel-head">
									<span class="emby-section-label">
										{{ t("emby-browser.selected-section") }}
									</span>
									<v-chip
										v-if="selectedSummary"
										size="small"
										:color="statusColor(selectedSummary.status)"
										:class="{
											'emby-chip-unknown':
												selectedSummary.status === 'unknown',
										}"
										variant="tonal"
										:prepend-icon="statusIcon(selectedSummary.status)"
									>
										{{ statusLabel(selectedSummary.status) }}
									</v-chip>
									<v-chip
										v-if="selectedSummary?.estimated"
										size="small"
										variant="text"
										class="emby-estimated"
									>
										{{ t("emby-browser.playability-estimated") }}
									</v-chip>
								</div>

								<div class="emby-panel-body">
									<div class="emby-panel-info">
										<span v-if="selected.SeriesName" class="emby-series">
											{{ selected.SeriesName }}
										</span>
										<strong class="emby-panel-title">{{
											selected.Name
										}}</strong>
										<span class="emby-meta">{{ itemMeta(selected) }}</span>
										<span v-if="selectedSummary" class="emby-specs">
											<span class="emby-specs-label">
												{{ t("emby-browser.source-specs") }}
											</span>
											{{ specsForSelection }}
										</span>
										<span v-if="preparing" class="emby-status-inline">
											<v-progress-circular
												indeterminate
												size="14"
												width="2"
											/>
											{{ t("emby-browser.preparing") }}
										</span>
										<span
											v-else-if="selectedReason"
											class="emby-unsupported"
											data-cy="emby-unsupported"
										>
											{{
												t(
													selectedDirectOnly
														? "emby-browser.unsupported-direct-only"
														: "emby-browser.unsupported",
													{ container: selectedReason },
												)
											}}
										</span>
										<span
											v-else-if="
												selectedSummary &&
												statusHint(selectedSummary) !== ''
											"
											class="emby-meta"
										>
											{{ statusHint(selectedSummary) }}
										</span>
										<div
											v-if="
												!preparing &&
												selectedSource &&
												compatibilityWarnings.length > 0
											"
											class="emby-compat-warnings"
											data-cy="emby-compat-warnings"
										>
											<span
												v-for="warning in compatibilityWarnings"
												:key="warning.kind"
												class="emby-compat-warning"
												:data-cy="`emby-${warning.kind}-warning`"
											>
												<v-icon :icon="mdiAlertOutline" size="15" />
												<span>{{ warning.text }}</span>
											</span>
										</div>
										<v-select
											v-if="
												!preparing &&
												selectedSource?.service === 'direct' &&
												availableSubtitles.length > 0
											"
											v-model="selectedSubtitleUrl"
											:items="subtitleSelectItems"
											item-title="title"
											item-value="value"
											:label="t('emby-browser.subtitle-track')"
											:prepend-inner-icon="mdiSubtitlesOutline"
											density="compact"
											variant="outlined"
											hide-details
											class="emby-subtitle-select"
											data-cy="emby-subtitle-select"
										/>
									</div>

									<div class="emby-panel-actions">
										<v-btn
											variant="tonal"
											size="large"
											:disabled="preparing || !selectedSource || busy"
											:prepend-icon="mdiPlaylistPlus"
											class="emby-action"
											data-cy="emby-add"
											@click="add(false)"
										>
											{{ t("emby-browser.add") }}
										</v-btn>
										<v-btn
											color="primary"
											:variant="selectedSource ? 'flat' : 'outlined'"
											size="large"
											:disabled="preparing || !selectedSource || busy"
											:loading="busy && playNowRequested"
											:prepend-icon="mdiPlay"
											class="emby-action"
											data-cy="emby-play-now"
											@click="add(true)"
										>
											{{ t("emby-browser.play-now") }}
										</v-btn>
									</div>
								</div>
							</section>
							<p v-else class="emby-hint">{{ t("emby-browser.select-hint") }}</p>
							<p class="emby-note">{{ t("emby-browser.note") }}</p>
						</aside>
					</div>
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
	mdiAlertOutline,
	mdiArrowLeft,
	mdiCheckCircleOutline,
	mdiClose,
	mdiCloseCircleOutline,
	mdiEyeOffOutline,
	mdiEyeOutline,
	mdiFolderOutline,
	mdiHelpCircleOutline,
	mdiMagnify,
	mdiMovieOpenOutline,
	mdiPlay,
	mdiPlaylistPlus,
	mdiServerNetwork,
	mdiSubtitlesOutline,
	mdiSwapHorizontal,
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
	extractEmbySubtitles,
	formatEmbyEpisodeCode,
	formatEmbyRuntime,
	getEmbyPlaybackInfo,
	getEmbyServerName,
	getEmbyViews,
	isCurrentBrowserLikelyNonChromium,
	listEmbyItems,
	normalizeEmbyServer,
	pickDefaultEmbySubtitle,
	pickPlayableEmbySource,
	rememberEmbyServer,
	rememberEmbyUsername,
	summarizeEmbyItemMedia,
	summarizeEmbyPlaybackMedia,
	type EmbyItem,
	type EmbyMediaSummary,
	type EmbyPlayabilityStatus,
	type EmbySubtitleTrack,
	type EmbyView,
	type PlayableEmbySource,
} from "@/util/emby";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
	"update:modelValue": [value: boolean];
	"added": [video: VideoAdd];
}>();

const { t, locale } = useI18n();
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
const showPassword = ref(false);

const SERVER_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const TRAILING_SLASHES = /\/+$/;
const WEB_UI_PATH = /\/web(?:\/index\.html)?$/;
const INDEX_HTML_PATH = /\/index\.html$/;

/** Split the stored or pasted server address into the fields the form shows. */
function splitServerInput(raw: string): {
	scheme: "http" | "https";
	host: string;
	port: string;
	path: string;
} {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { scheme: "https", host: "", port: "", path: "" };
	}
	// Users leave the scheme off as often as not; https is the safer guess for a remote
	// host, and the local-network case is the one that needs an explicit http:// anyway.
	const withScheme = SERVER_SCHEME_PATTERN.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		const path = url.pathname
			.replace(TRAILING_SLASHES, "")
			.replace(WEB_UI_PATH, "")
			.replace(INDEX_HTML_PATH, "");
		return {
			scheme: url.protocol === "http:" ? "http" : "https",
			host: url.hostname,
			port: url.port,
			path,
		};
	} catch {
		return { scheme: "https", host: trimmed, port: "", path: "" };
	}
}

const initialServer = splitServerInput(serverInput.value);
const schemeInput = ref<"http" | "https">(initialServer.scheme);
const hostInput = ref(initialServer.host);
const portInput = ref(initialServer.port);
const pathInput = ref(initialServer.path);
const showPath = ref(initialServer.path !== "");

const schemeOptions = computed(() => [
	{ value: "https", title: t("emby-browser.server-scheme-https") },
	{ value: "http", title: t("emby-browser.server-scheme-http") },
]);

const serverUrl = computed(() => {
	const host = hostInput.value.trim();
	const port = portInput.value.trim();
	const path = pathInput.value.trim().replace(TRAILING_SLASHES, "");
	const authority = port === "" ? host : `${host}:${port}`;
	return `${schemeInput.value}://${authority}${path}`;
});

/** A pasted URL in the host field would otherwise be treated as a hostname. */
function absorbServerText(value: string): void {
	if (!SERVER_SCHEME_PATTERN.test(value) && !value.includes("/")) {
		return;
	}
	const parts = splitServerInput(value);
	schemeInput.value = parts.scheme;
	hostInput.value = parts.host;
	portInput.value = parts.port;
	pathInput.value = parts.path;
	showPath.value = showPath.value || parts.path !== "";
}

function absorbPortText(value: string): void {
	const digits = value.replace(/[^\d]/g, "");
	if (digits !== value) {
		portInput.value = digits;
	}
}

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
const selectedDirectOnly = ref(false);
const availableSubtitles = ref<EmbySubtitleTrack[]>([]);
const selectedSubtitleUrl = ref("");
const preparing = ref(false);
const busy = ref(false);
const playNowRequested = ref(false);
/** Verified media summary for the selected item, filled once PlaybackInfo answers. */
const playbackSummary = ref<EmbyMediaSummary>();
/** Set while the grid shows one series' episodes, so "back" can return to the library. */
const seriesContext = ref<{ id: string; name: string }>();

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

const resultsLabel = computed(() => {
	if (total.value === 0) {
		return "";
	}
	return t("emby-browser.results-count", { shown: items.value.length, total: total.value });
});

/** List-level guess from the container alone; PlaybackInfo replaces it once selected. */
function summaryFor(item: EmbyItem): EmbyMediaSummary | undefined {
	return summarizeEmbyItemMedia(item);
}

function specsFor(item: EmbyItem): string {
	const summary = summaryFor(item);
	if (!summary) {
		return "";
	}
	const estimated = summary.estimated ? ` · ${t("emby-browser.playability-estimated")}` : "";
	return `${summary.label}${estimated}`;
}

/** Tile tint class for a grid item, so each playability state has its own background. */
function tileStatusClass(item: EmbyItem): string {
	const summary = summaryFor(item);
	return summary ? `emby-tile-${summary.status}` : "";
}

/** Badge copy for a grid tile: playability when known, otherwise the series marker. */
function badgeLabel(item: EmbyItem): string {
	const summary = summaryFor(item);
	if (summary) {
		return statusLabel(summary.status);
	}
	return item.Type === "Series" ? t("emby-browser.series-badge") : "";
}

function badgeColor(item: EmbyItem): string {
	const summary = summaryFor(item);
	return summary ? statusColor(summary.status) : "primary";
}

const selectedSummary = computed<EmbyMediaSummary | undefined>(() => {
	if (!selected.value) {
		return undefined;
	}
	return playbackSummary.value ?? summaryFor(selected.value);
});

const specsForSelection = computed(() => {
	const summary = selectedSummary.value;
	if (!summary) {
		return "";
	}
	return summary.resolution ? `${summary.label} · ${summary.resolution}` : summary.label;
});

function statusLabel(status: EmbyPlayabilityStatus): string {
	switch (status) {
		case "direct":
			return t("emby-browser.playability-direct");
		case "direct-limited":
			return t("emby-browser.playability-direct-limited");
		case "transcode":
			return t("emby-browser.playability-transcode");
		case "unknown":
			return t("emby-browser.playability-unknown");
		default:
			return t("emby-browser.playability-unsupported");
	}
}

function statusColor(status: EmbyPlayabilityStatus): string {
	switch (status) {
		case "direct":
			return "success";
		case "direct-limited":
		case "transcode":
			return "warning";
		case "unknown":
			return "secondary";
		default:
			return "error";
	}
}

/**
 * "Unverified" gets a neutral grey chip instead of a theme colour: in the teal palette
 * `secondary` is #ffd166, all but identical to the amber `warning` used for transcoding,
 * which made the two states indistinguishable. Neutral grey also reads as "unknown" in
 * every palette, unlike role colours that are swapped around between themes.
 * The grey itself lives in `.emby-badge-unknown` / `.emby-chip-unknown` below: scoped
 * classes outrank Vuetify's `bg-*` helpers, which an inline style would not survive.
 */
function statusIcon(status: EmbyPlayabilityStatus): string {
	switch (status) {
		case "direct":
			return mdiCheckCircleOutline;
		case "direct-limited":
			return mdiAlertOutline;
		case "transcode":
			return mdiSwapHorizontal;
		case "unknown":
			return mdiHelpCircleOutline;
		default:
			return mdiCloseCircleOutline;
	}
}

function statusHint(summary: EmbyMediaSummary): string {
	if (summary.status === "direct") {
		return t("emby-browser.playability-direct-hint");
	}
	if (summary.status === "direct-limited") {
		return t("emby-browser.playability-direct-limited-hint");
	}
	if (summary.status === "transcode") {
		return t(
			summary.estimated
				? "emby-browser.playability-transcode-estimated"
				: "emby-browser.playability-transcode-hint",
		);
	}
	if (summary.status === "unknown") {
		return t("emby-browser.playability-unknown-hint");
	}
	return "";
}

const compatibilityWarnings = computed(() => {
	const compatibility = selectedSummary.value?.compatibility;
	if (!compatibility) {
		return [];
	}
	const warnings: { kind: "browser" | "audio" | "video"; text: string }[] = [];
	if (compatibility.chromiumOnly && isCurrentBrowserLikelyNonChromium()) {
		warnings.push({
			kind: "browser",
			text: t("emby-browser.compat-non-chromium"),
		});
	}
	if (compatibility.audioStatus === "incompatible" && compatibility.audioCodec) {
		warnings.push({
			kind: "audio",
			text: t("emby-browser.compat-audio-incompatible", {
				codec: compatibility.audioCodec,
			}),
		});
	} else if (
		compatibility.audioStatus === "fallback-track" &&
		compatibility.audioCodec &&
		compatibility.compatibleAudioCodec
	) {
		warnings.push({
			kind: "audio",
			text: t("emby-browser.compat-audio-fallback-track", {
				codec: compatibility.audioCodec,
				fallback: compatibility.compatibleAudioCodec,
			}),
		});
	}
	if (compatibility.unsupportedVideoCodec) {
		warnings.push({
			kind: "video",
			text: t("emby-browser.compat-video-unsupported", {
				codec: compatibility.unsupportedVideoCodec,
			}),
		});
	}
	return warnings;
});

// Kept outside computed() to avoid Biome's noVueRefAsOperand false positive on map callbacks.
function subtitleTracksToOptions(tracks: EmbySubtitleTrack[], noneLabel: string) {
	return [
		{ title: noneLabel, value: "" },
		...tracks.map(track => ({
			title: track.label,
			value: track.url,
		})),
	];
}

const subtitleSelectItems = computed(() =>
	subtitleTracksToOptions(availableSubtitles.value, t("emby-browser.subtitle-none")),
);

function resetLibrary(): void {
	listGeneration++;
	prepareGeneration++;
	preparing.value = false;
	items.value = [];
	total.value = 0;
	selected.value = undefined;
	selectedSource.value = undefined;
	selectedReason.value = "";
	selectedDirectOnly.value = false;
	availableSubtitles.value = [];
	selectedSubtitleUrl.value = "";
	playbackSummary.value = undefined;
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
			parentId: seriesContext.value?.id ?? (selectedView.value || undefined),
			search: search.value,
			startIndex: append ? items.value.length : 0,
			// Inside a series only episodes make sense; a global search keeps everything so
			// the show itself can be found and opened.
			itemTypes:
				seriesContext.value && search.value.trim() === ""
					? "Episode"
					: "Movie,Series,Episode",
			// SortName orders episodes alphabetically by title, which reads as a puzzle when
			// the grid is one show's episodes.
			sortBy:
				seriesContext.value && search.value.trim() === ""
					? "ParentIndexNumber,IndexNumber"
					: undefined,
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

function clearSearch(): void {
	search.value = "";
	reload();
}

async function connect(): Promise<void> {
	if (connecting.value) {
		return;
	}
	error.value = "";
	connecting.value = true;
	try {
		const normalized = normalizeEmbyServer(serverUrl.value);
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
	seriesContext.value = undefined;
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
	const code = formatEmbyEpisodeCode(item);
	if (code !== "") {
		parts.push(code);
	}
	if (typeof item.ProductionYear === "number") {
		parts.push(String(item.ProductionYear));
	}
	const runtime = formatEmbyRuntime(item.RunTimeTicks);
	if (runtime !== "") {
		parts.push(runtime);
	}
	return parts.join(" · ");
}

async function openSeries(item: EmbyItem): Promise<void> {
	seriesContext.value = { id: item.Id, name: item.Name };
	search.value = "";
	resetLibrary();
	await load(false);
}

function leaveSeries(): void {
	seriesContext.value = undefined;
	resetLibrary();
	void load(false);
}

async function select(item: EmbyItem): Promise<void> {
	if (selected.value?.Id === item.Id) {
		return;
	}
	if (item.Type === "Series") {
		await openSeries(item);
		return;
	}
	selected.value = item;
	selectedSource.value = undefined;
	selectedReason.value = "";
	selectedDirectOnly.value = false;
	availableSubtitles.value = [];
	selectedSubtitleUrl.value = "";
	playbackSummary.value = undefined;
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
		const result = pickPlayableEmbySource(server.value, playback, item, {
			token: token.value,
		});
		playbackSummary.value = summarizeEmbyPlaybackMedia(item, playback, result);
		if (result.source) {
			selectedSource.value = result.source;
			if (result.source.service === "direct") {
				const tracks = extractEmbySubtitles(
					server.value,
					token.value,
					item,
					result.source.source,
				);
				availableSubtitles.value = tracks;
				selectedSubtitleUrl.value =
					pickDefaultEmbySubtitle(tracks, String(locale.value))?.url ?? "";
			}
		} else {
			selectedReason.value = result.reason ?? "unknown";
			selectedDirectOnly.value = result.directOnly === true;
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
			subtitleUrl: selectedSubtitleUrl.value || undefined,
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
		availableSubtitles.value = [];
		selectedSubtitleUrl.value = "";
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

.emby-header {
	display: flex;
	align-items: center;
	gap: 10px;
	padding-inline: 20px;
}

.emby-header-icon {
	opacity: 0.8;
}

.emby-title {
	font-size: 1.15rem;
	font-weight: 600;
	letter-spacing: 0.01em;
}

.emby-header-chip {
	max-width: 46ch;
	overflow: hidden;
	text-overflow: ellipsis;
}

.emby-body {
	padding: 20px;
}

/* ---------- connect form ---------- */

.emby-help,
.emby-note,
.emby-hint {
	color: rgba(var(--v-theme-on-surface), 0.78);
	font-size: 0.92rem;
	line-height: 1.5;
}

.emby-help {
	margin-bottom: 16px;
}

.emby-note {
	margin-top: 14px;
}

.emby-hint {
	margin-top: 8px;
}

.emby-section-label {
	margin: 0 0 6px;
	font-size: 0.8rem;
	font-weight: 600;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: rgba(var(--v-theme-on-surface), 0.55);
}

.emby-section-gap {
	margin-top: 20px;
}

.emby-server-row {
	display: grid;
	grid-template-columns: 120px minmax(0, 1fr) 120px;
	gap: 12px;
}

.emby-credentials {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.emby-path-toggle {
	margin-top: 6px;
	margin-left: -10px;
}

.emby-endpoint {
	display: flex;
	align-items: baseline;
	gap: 10px;
	margin: 12px 0 0;
	font-size: 0.88rem;
	color: rgba(var(--v-theme-on-surface), 0.75);
	word-break: break-all;
}

.emby-endpoint code {
	padding: 2px 8px;
	border-radius: 6px;
	background: rgba(var(--v-theme-on-surface), 0.08);
	font-size: 0.86rem;
}

.emby-connect-actions {
	display: flex;
	justify-content: flex-end;
	margin-top: 20px;
}

.emby-connect-button {
	min-width: 168px;
}

/* ---------- toolbar ---------- */

.emby-toolbar {
	display: grid;
	grid-template-columns: minmax(160px, 0.75fr) minmax(200px, 1.25fr);
	gap: 12px;
}

.emby-toolbar-meta {
	display: flex;
	align-items: center;
	gap: 4px;
	margin: 8px 0 14px;
	min-height: 32px;
}

.emby-count {
	font-size: 0.86rem;
	color: rgba(var(--v-theme-on-surface), 0.7);
}

.emby-series-bar {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 14px;
}

.emby-series-name {
	font-size: 1rem;
	font-weight: 600;
	color: rgba(var(--v-theme-on-surface), 0.8);
}

/* ---------- layout ---------- */

.emby-layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 336px;
	gap: 20px;
	align-items: start;
}

.emby-main {
	min-width: 0;
}

.emby-side {
	position: sticky;
	top: 0;
	min-width: 0;
}

.emby-side .emby-panel-body {
	flex-direction: column;
	gap: 14px;
}

.emby-side .emby-panel-actions {
	width: 100%;
}

.emby-side .emby-action {
	flex: 1 1 0;
}

/* ---------- grid ---------- */

.emby-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
	gap: 14px;
}

.emby-grid-skeleton {
	min-height: 200px;
}

.emby-skeleton {
	aspect-ratio: 2 / 3;
	border-radius: 8px;
	background: rgba(var(--v-theme-on-surface), 0.06);
	animation: emby-pulse 1.6s ease-in-out infinite;
}

@keyframes emby-pulse {
	0%,
	100% {
		opacity: 0.55;
	}
	50% {
		opacity: 1;
	}
}

.emby-tile {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 5px;
	padding: 8px;
	border: 2px solid transparent;
	border-radius: 10px;
	background: transparent;
	color: inherit;
	text-align: left;
	cursor: pointer;
	transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}

/*
 * Per-status tile tints: "needs transcoding" is amber, "unverified" is neutral grey with a
 * dashed edge. Different hue and border treatment, so the two never blur together in the
 * grid. Hover/selected rules below intentionally override these.
 */
.emby-tile-direct {
	background: rgba(var(--v-theme-success), 0.06);
}

.emby-tile-transcode {
	background: rgba(var(--v-theme-warning), 0.12);
	border-color: rgba(var(--v-theme-warning), 0.5);
}

.emby-tile-unknown {
	background: rgba(var(--v-theme-on-surface), 0.16);
	border-color: rgba(var(--v-theme-on-surface), 0.35);
	border-style: dashed;
}

.emby-tile-unsupported {
	background: rgba(var(--v-theme-error), 0.1);
}

.emby-tile:hover {
	background: rgba(var(--v-theme-primary), 0.07);
	transform: translateY(-1px);
}

.emby-tile:focus-visible {
	outline: 2px solid rgb(var(--v-theme-primary));
	outline-offset: 2px;
}

.emby-tile-selected {
	border-color: rgb(var(--v-theme-primary));
	border-style: solid;
	background: rgba(var(--v-theme-primary), 0.1);
}

.emby-poster-wrap {
	position: relative;
	aspect-ratio: 2 / 3;
	border-radius: 8px;
	overflow: hidden;
	background: rgba(var(--v-theme-on-surface), 0.06);
}

.emby-poster {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.emby-poster-empty {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	color: rgba(var(--v-theme-on-surface), 0.4);
}

.emby-tile-badge {
	position: absolute;
	top: 6px;
	right: 6px;
	height: 26px;
	padding-inline: 10px;
	font-size: 0.8rem;
	font-weight: 700;
	letter-spacing: 0.02em;
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}

/* Neutral grey for "unverified": teal's secondary is amber, i.e. the transcoding hue. */
.emby-tile-badge.emby-badge-unknown {
	background: rgba(var(--v-theme-on-surface), 0.82);
	color: rgb(var(--v-theme-surface));
}

.v-chip.emby-chip-unknown {
	background: rgba(var(--v-theme-on-surface), 0.12);
	color: rgba(var(--v-theme-on-surface), 0.9);
}

.emby-series {
	font-size: 0.8rem;
	color: rgba(var(--v-theme-on-surface), 0.7);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.emby-name {
	font-size: 0.96rem;
	font-weight: 600;
	line-height: 1.3;
	/* Two lines always, so the meta row sits at the same height on every tile. */
	min-height: 2.5em;
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.emby-meta {
	font-size: 0.84rem;
	color: rgba(var(--v-theme-on-surface), 0.7);
}

.emby-specs {
	font-size: 0.82rem;
	color: rgba(var(--v-theme-on-surface), 0.7);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.emby-specs-label {
	margin-right: 6px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-size: 0.74rem;
}

/* ---------- status ---------- */

.emby-status {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 10px;
	min-height: 160px;
	text-align: center;
	color: rgba(var(--v-theme-on-surface), 0.7);
}

.emby-more {
	display: flex;
	justify-content: center;
	margin-top: 16px;
}

.emby-status-inline {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 0.9rem;
	color: rgba(var(--v-theme-on-surface), 0.75);
}

.emby-unsupported {
	color: rgb(var(--v-theme-error));
	font-size: 0.9rem;
	max-width: 52ch;
}

.emby-compat-warnings {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin-top: 6px;
	padding: 8px 10px;
	border-radius: 8px;
	background: rgba(var(--v-theme-warning), 0.12);
	border: 1px solid rgba(var(--v-theme-warning), 0.35);
}

.emby-compat-warning {
	display: flex;
	align-items: flex-start;
	gap: 6px;
	font-size: 0.83rem;
	line-height: 1.4;
	color: rgba(var(--v-theme-on-surface), 0.9);
}

.emby-compat-warning .v-icon {
	flex-shrink: 0;
	margin-top: 2px;
	color: rgb(var(--v-theme-warning));
}

.emby-subtitle-select {
	margin-top: 8px;
}

/* ---------- selected panel ---------- */

.emby-panel {
	border: 1px solid rgba(var(--v-border-color), 0.3);
	border-radius: 12px;
	padding: 16px;
	background: rgba(var(--v-theme-on-surface), 0.03);
}

.emby-panel-head {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 10px;
}

.emby-estimated {
	opacity: 0.7;
}

.emby-panel-body {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 20px;
	flex-wrap: wrap;
}

.emby-panel-info {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
	flex: 1 1 320px;
}

.emby-panel-title {
	font-size: 1.1rem;
	line-height: 1.3;
}

.emby-panel-actions {
	display: flex;
	gap: 10px;
	flex-wrap: wrap;
}

/* ---------- responsive ---------- */

@media (max-width: 1000px) {
	.emby-layout {
		grid-template-columns: minmax(0, 1fr);
		gap: 0;
	}

	/* No room for a side rail: pin the panel to the bottom edge instead. */
	.emby-side-pinned {
		position: sticky;
		bottom: -20px;
		z-index: 3;
		margin: 16px -20px -20px;
		padding: 12px 20px 20px;
		background: rgb(var(--v-theme-surface));
		border-top: 1px solid rgba(var(--v-border-color), 0.3);
		box-shadow: 0 -8px 20px rgba(0, 0, 0, 0.18);
	}

	.emby-side-pinned .emby-panel {
		padding: 0;
		border: 0;
		background: transparent;
	}

	.emby-side-pinned .emby-panel-body {
		flex-direction: column;
		gap: 12px;
	}

	.emby-side-pinned .emby-panel-actions {
		width: 100%;
	}

	.emby-side-pinned .emby-action {
		flex: 1 1 0;
	}
}

@media (max-width: 640px) {
	.emby-body {
		padding: 14px;
	}

	.emby-server-row,
	.emby-credentials,
	.emby-toolbar {
		grid-template-columns: 1fr;
	}

	.emby-grid {
		grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
		gap: 10px;
	}

	.emby-panel-body {
		flex-direction: column;
	}

	.emby-panel-actions {
		width: 100%;
		flex-direction: column;
	}

	.emby-action {
		width: 100%;
	}
}
</style>
