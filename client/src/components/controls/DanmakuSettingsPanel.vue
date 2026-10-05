<template>
	<div class="danmaku-panel">
		<div v-if="!danmakuAvailable" class="danmaku-unavailable">
			{{ $t("room.danmaku.unavailable") }}
		</div>
		<div class="danmaku-page-switch">
			<v-btn-toggle
				v-model="page"
				mandatory
				density="compact"
				color="primary"
				divided
				class="danmaku-pages"
			>
				<v-btn value="basic" size="small" data-cy="danmaku-page-basic">
					{{ $t("room.danmaku.page-basic") }}
				</v-btn>
				<v-btn value="sources" size="small" data-cy="danmaku-page-sources">
					{{ $t("room.danmaku.page-sources") }}
				</v-btn>
			</v-btn-toggle>
		</div>
		<template v-if="page === 'basic'">
			<div class="danmaku-page">
				<div class="danmaku-row danmaku-row-slider">
					<div class="danmaku-row-top">
						<span class="danmaku-row-label">{{ $t("room.danmaku.opacity") }}</span>
						<span class="danmaku-row-value">{{ opacityPercent }}%</span>
					</div>
					<v-slider
						v-model="danmakuOpacity"
						:min="0.1"
						:max="1"
						:step="0.05"
						color="primary"
						density="compact"
						hide-details
						data-cy="danmaku-opacity"
					/>
				</div>
				<div class="danmaku-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.font-size") }}</span>
					<v-btn-toggle
						v-model="danmakuFontSize"
						mandatory
						density="compact"
						color="primary"
						class="danmaku-chips"
					>
						<v-btn
							v-for="size in DANMAKU_FONT_SIZE_OPTIONS"
							:key="size"
							:value="size"
							size="x-small"
							:data-cy="`danmaku-font-${size}`"
						>
							{{ $t(`room.danmaku.font-size-${size}`) }}
						</v-btn>
					</v-btn-toggle>
				</div>
				<div class="danmaku-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.speed") }}</span>
					<v-btn-toggle
						v-model="danmakuSpeed"
						mandatory
						density="compact"
						color="primary"
						class="danmaku-chips danmaku-speed-chips"
					>
						<v-btn
							v-for="speed in DANMAKU_SPEED_OPTIONS"
							:key="speed"
							:value="speed"
							size="x-small"
							:data-cy="`danmaku-speed-${speed}`"
						>
							{{ speed }}
						</v-btn>
					</v-btn-toggle>
				</div>
				<div class="danmaku-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.area") }}</span>
					<v-btn-toggle
						v-model="danmakuDisplayArea"
						mandatory
						density="compact"
						color="primary"
						class="danmaku-chips"
					>
						<v-btn
							v-for="area in DANMAKU_AREAS"
							:key="area"
							:value="area"
							size="x-small"
							:data-cy="`danmaku-area-${area}`"
						>
							{{ $t(`room.danmaku.area-${area}`) }}
						</v-btn>
					</v-btn-toggle>
				</div>
				<div class="danmaku-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.density") }}</span>
					<v-btn-toggle
						v-model="danmakuDensity"
						mandatory
						density="compact"
						color="primary"
						class="danmaku-chips"
					>
						<v-btn
							v-for="density in DANMAKU_DENSITY_OPTIONS"
							:key="density"
							:value="density"
							size="x-small"
							:data-cy="`danmaku-density-${density}`"
						>
							{{ $t(`room.danmaku.density-${density}`) }}
						</v-btn>
					</v-btn-toggle>
				</div>
				<div class="danmaku-row danmaku-row-stack">
					<span class="danmaku-row-label">{{ $t("room.danmaku.blocking") }}</span>
					<v-btn-toggle
						v-model="blockedTypes"
						multiple
						density="compact"
						color="primary"
						class="danmaku-chips"
					>
						<v-btn value="scroll" size="x-small" data-cy="danmaku-block-scroll">
							{{ $t("room.danmaku.block-scroll") }}
						</v-btn>
						<v-btn value="top" size="x-small" data-cy="danmaku-block-top">
							{{ $t("room.danmaku.block-top") }}
						</v-btn>
						<v-btn value="bottom" size="x-small" data-cy="danmaku-block-bottom">
							{{ $t("room.danmaku.block-bottom") }}
						</v-btn>
						<v-btn value="colored" size="x-small" data-cy="danmaku-block-colored">
							{{ $t("room.danmaku.block-colored") }}
						</v-btn>
					</v-btn-toggle>
				</div>
				<div class="danmaku-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.anti-collision") }}</span>
					<v-switch
						v-model="danmakuAntiCollision"
						color="primary"
						density="compact"
						hide-details
						class="danmaku-switch"
						data-cy="danmaku-anti-collision"
					/>
				</div>
			</div>
		</template>
		<template v-else>
			<!-- The search drills down inside the page's fixed height: results first, then the
			     episode list of the picked show, then back to the sources. -->
			<div v-if="searchView" class="danmaku-page danmaku-search-view">
				<div class="danmaku-search-view-head">
					<v-btn
						size="x-small"
						variant="text"
						@click="searchBack"
						data-cy="danmaku-search-back"
					>
						{{ $t("room.danmaku.back") }}
					</v-btn>
					<span class="danmaku-search-view-title" :title="searchTitle">{{
						searchTitle
					}}</span>
					<v-progress-circular
						v-if="searchBusy"
						size="14"
						width="2"
						indeterminate
						color="primary"
					/>
				</div>
				<div class="danmaku-search-body">
					<template v-if="searchView.step === 'results'">
						<v-list
							v-if="searchView.source === 'girigiri' && girigiriResults.length"
							density="compact"
							class="danmaku-search-results"
						>
							<v-list-item
								v-for="item in girigiriResults"
								:key="item.id"
								:title="item.name"
								data-cy="danmaku-search-result"
								@click="selectGirigiriShow(item)"
							/>
						</v-list>
						<v-list
							v-else-if="searchView.source === 'danmu' && results.length"
							density="compact"
							class="danmaku-search-results"
						>
							<v-list-item
								v-for="item in results"
								:key="String(item.animeId)"
								:title="item.title"
								:subtitle="item.source"
								data-cy="danmaku-search-result"
								@click="selectAnime(item)"
							/>
						</v-list>
					</template>
					<template v-else>
						<v-list
							v-if="searchView.source === 'danmu'"
							density="compact"
							class="danmaku-search-results"
						>
							<v-list-item
								v-for="episode in episodes"
								:key="String(episode.episodeId)"
								:title="episode.title"
								data-cy="danmaku-search-episode"
								@click="bindEpisode(episode)"
							/>
						</v-list>
						<div v-else class="danmaku-search-results danmaku-episodes">
							<div
								v-for="line in girigiriLines"
								:key="line.line"
								class="danmaku-line"
							>
								<div class="danmaku-line-label">
									{{ $t("room.danmaku.girigiri-line", { n: line.line }) }}
								</div>
								<div class="danmaku-line-chips">
									<v-btn
										v-for="episode in line.episodes"
										:key="episode.number"
										size="x-small"
										variant="tonal"
										:data-cy="`danmaku-girigiri-ep-${line.line}-${episode.number}`"
										@click="bindGirigiriEpisode(line, episode)"
									>
										{{
											$t("room.danmaku.girigiri-episode", {
												n: episode.number,
											})
										}}
									</v-btn>
								</div>
							</div>
						</div>
					</template>
					<div v-if="searchEmpty && !searchBusy" class="danmaku-search-empty">
						{{ searchEmptyText }}
					</div>
				</div>
			</div>
			<div v-else class="danmaku-page danmaku-sources">
				<div class="danmaku-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.binding-title") }}</span>
					<span v-if="binding" class="danmaku-match-label" :title="binding.label">{{
						binding.label
					}}</span>
					<span v-else class="danmaku-match-label danmaku-match-empty">
						{{ $t("room.danmaku.not-bound") }}
					</span>
					<span
						class="danmaku-count"
						:title="$t('room.danmaku.loaded')"
						data-cy="danmaku-loaded-count"
						>{{ $t("room.danmaku.loaded-count", { count: loadedCount }) }}</span
					>
					<v-btn
						v-if="binding"
						size="x-small"
						variant="text"
						@click="clearBinding"
						data-cy="danmaku-unbind"
					>
						{{ $t("room.danmaku.unbind") }}
					</v-btn>
				</div>
				<div v-if="binding" class="danmaku-row danmaku-slider-row">
					<span class="danmaku-row-label">{{ $t("room.danmaku.offset") }}</span>
					<v-slider
						v-model="offsetSeconds"
						:min="-60"
						:max="60"
						:step="0.5"
						color="primary"
						density="compact"
						hide-details
						class="danmaku-inline-slider"
						data-cy="danmaku-offset"
					/>
					<span class="danmaku-row-value">{{ offsetLabel }}</span>
				</div>
				<div class="danmaku-section">
					<div class="danmaku-section-title">girigiri</div>
					<div class="danmaku-search-inline">
						<v-text-field
							v-model="girigiriKeyword"
							density="compact"
							variant="outlined"
							hide-details
							class="danmaku-slim-field"
							:placeholder="$t('room.danmaku.girigiri-placeholder')"
							data-cy="danmaku-girigiri-input"
							@keyup.enter="runGirigiriSearch"
						/>
						<v-btn
							size="x-small"
							variant="tonal"
							:loading="girigiriSearching"
							@click="runGirigiriSearch"
						>
							{{ $t("room.danmaku.search-action") }}
						</v-btn>
					</div>
				</div>
				<div class="danmaku-section">
					<div class="danmaku-section-title">danmu_api</div>
					<v-text-field
						v-model="danmakuApiBase"
						density="compact"
						variant="outlined"
						hide-details
						class="danmaku-slim-field"
						:placeholder="$t('room.danmaku.api-base-placeholder')"
						data-cy="danmaku-api-base"
					/>
					<div class="danmaku-search-inline">
						<v-text-field
							v-model="keyword"
							density="compact"
							variant="outlined"
							hide-details
							class="danmaku-slim-field"
							:placeholder="$t('room.danmaku.search-placeholder')"
							data-cy="danmaku-search-input"
							@keyup.enter="runSearch"
						/>
						<v-btn
							size="x-small"
							variant="tonal"
							:loading="searching"
							:disabled="!danmakuApiBase || !currentVideoUrl"
							@click="runSearch"
						>
							{{ $t("room.danmaku.search-action") }}
						</v-btn>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useStore } from "@/store";
import {
	DANMAKU_AREAS,
	DANMAKU_DENSITY_OPTIONS,
	DANMAKU_FONT_SIZE_OPTIONS,
	DANMAKU_SPEED_OPTIONS,
} from "@/stores/settings";
import {
	fetchEpisodes,
	forgetBinding,
	getBinding,
	rememberBinding,
	searchAnime,
	type DanmakuEpisode,
	type DanmakuSearchResult,
} from "@/util/danmaku/danmu-api";
import {
	fetchGirigiriEpisodes,
	searchGirigiri,
	type GirigiriEpisode,
	type GirigiriLine,
	type GirigiriSearchResult,
} from "@/util/danmaku/girigiri-api";
import { useDanmaku } from "../composables";

const { t } = useI18n();

const store = useStore();
const danmaku = useDanmaku();
const danmakuAvailable = computed(() => danmaku.available.value);
const currentVideoUrl = computed(() => danmaku.currentVideoUrl.value);
/** Comments the layer actually loaded for the current video. */
const loadedCount = computed(() => danmaku.loadedCount.value);
/** The panel has two pages: appearance settings and the comment sources. */
const page = ref<"basic" | "sources">("basic");
const danmakuOpacity = computed({
	get: () => store.state.settings.danmakuOpacity,
	set: value => store.commit("settings/UPDATE", { danmakuOpacity: value }),
});
const opacityPercent = computed(() => Math.round(store.state.settings.danmakuOpacity * 100));
const danmakuFontSize = computed({
	get: () => store.state.settings.danmakuFontSize,
	set: value => store.commit("settings/UPDATE", { danmakuFontSize: value }),
});
const danmakuSpeed = computed({
	get: () => store.state.settings.danmakuSpeed,
	set: value => store.commit("settings/UPDATE", { danmakuSpeed: value }),
});
const danmakuDisplayArea = computed({
	get: () => store.state.settings.danmakuDisplayArea,
	set: value => store.commit("settings/UPDATE", { danmakuDisplayArea: value }),
});
const danmakuDensity = computed({
	get: () => store.state.settings.danmakuDensity,
	set: value => store.commit("settings/UPDATE", { danmakuDensity: value }),
});
const danmakuAntiCollision = computed({
	get: () => store.state.settings.danmakuAntiCollision,
	set: value => store.commit("settings/UPDATE", { danmakuAntiCollision: value }),
});

/**
 * The self-hosted aggregator (danmu_api) needs a match before it can serve a track, so the
 * panel both carries its base URL and offers the manual match the automatic one falls back
 * from; girigiri's search lives above it. The binding belongs to the current video.
 */
const danmakuApiBase = computed({
	get: () => store.state.settings.danmakuApiBase,
	set: value => store.commit("settings/UPDATE", { danmakuApiBase: value }),
});
const binding = computed(() => {
	const url = currentVideoUrl.value;
	return url ? getBinding(url) : null;
});

/** Which search the page is showing, drilled down inside the page's fixed height. */
type SearchSource = "girigiri" | "danmu";
const searchView = ref<{ source: SearchSource; step: "results" | "episodes" } | null>(null);
const keyword = ref("");
const searching = ref(false);
const results = ref<DanmakuSearchResult[]>([]);
const episodes = ref<DanmakuEpisode[]>([]);
const selectedAnimeTitle = ref("");
const girigiriKeyword = ref("");
const girigiriSearching = ref(false);
const girigiriResults = ref<GirigiriSearchResult[]>([]);
const girigiriLines = ref<GirigiriLine[]>([]);
const girigiriShowTitle = ref("");

const searchBusy = computed(() => searching.value || girigiriSearching.value);
const searchTitle = computed(() => {
	const view = searchView.value;
	if (!view) {
		return "";
	}
	if (view.step === "episodes") {
		return view.source === "girigiri" ? girigiriShowTitle.value : selectedAnimeTitle.value;
	}
	return view.source === "girigiri" ? "girigiri" : "danmu_api";
});
const searchEmpty = computed(() => {
	const view = searchView.value;
	if (!view) {
		return false;
	}
	if (view.source === "girigiri") {
		return view.step === "results"
			? girigiriResults.value.length === 0
			: girigiriLines.value.length === 0;
	}
	return view.step === "results" ? results.value.length === 0 : episodes.value.length === 0;
});
const searchEmptyText = computed(() =>
	t(
		searchView.value?.source === "girigiri"
			? "room.danmaku.girigiri-empty"
			: "room.danmaku.search-empty",
	),
);

/** One search is shown at a time; closing it restores the sources page. */
function closeSearch() {
	searchView.value = null;
	results.value = [];
	episodes.value = [];
	selectedAnimeTitle.value = "";
	girigiriResults.value = [];
	girigiriLines.value = [];
	girigiriShowTitle.value = "";
}

function searchBack() {
	const view = searchView.value;
	if (!view) {
		return;
	}
	if (view.step === "episodes") {
		if (view.source === "girigiri") {
			clearGirigiriSelection();
		} else {
			clearAnimeSelection();
		}
		searchView.value = { source: view.source, step: "results" };
		return;
	}
	closeSearch();
}

watch(page, value => {
	if (value !== "sources") {
		closeSearch();
	}
});

async function runSearch() {
	clearAnimeSelection();
	results.value = [];
	searchView.value = { source: "danmu", step: "results" };
	searching.value = true;
	try {
		results.value = await searchAnime(keyword.value);
	} finally {
		searching.value = false;
	}
}

async function selectAnime(item: DanmakuSearchResult) {
	selectedAnimeTitle.value = item.title;
	episodes.value = [];
	searchView.value = { source: "danmu", step: "episodes" };
	searching.value = true;
	try {
		episodes.value = await fetchEpisodes(item.animeId);
	} finally {
		searching.value = false;
	}
}

function clearAnimeSelection() {
	selectedAnimeTitle.value = "";
	episodes.value = [];
}

function bindEpisode(episode: DanmakuEpisode) {
	const url = currentVideoUrl.value;
	if (!url) {
		return;
	}
	const label = [selectedAnimeTitle.value, episode.title].filter(Boolean).join(" · ");
	rememberBinding(url, {
		provider: "danmu-api",
		episodeId: episode.episodeId,
		label,
		offset: binding.value?.offset ?? 0,
	});
	// The panel collapses back to its compact state; the keyword stays for the next episode.
	closeSearch();
}

async function runGirigiriSearch() {
	clearGirigiriSelection();
	girigiriResults.value = [];
	searchView.value = { source: "girigiri", step: "results" };
	girigiriSearching.value = true;
	try {
		girigiriResults.value = await searchGirigiri(girigiriKeyword.value);
	} finally {
		girigiriSearching.value = false;
	}
}

async function selectGirigiriShow(item: GirigiriSearchResult) {
	girigiriShowTitle.value = item.name;
	girigiriLines.value = [];
	searchView.value = { source: "girigiri", step: "episodes" };
	girigiriSearching.value = true;
	try {
		girigiriLines.value = await fetchGirigiriEpisodes(item.id);
	} finally {
		girigiriSearching.value = false;
	}
}

function clearGirigiriSelection() {
	girigiriShowTitle.value = "";
	girigiriLines.value = [];
}

function bindGirigiriEpisode(line: GirigiriLine, episode: GirigiriEpisode) {
	const url = currentVideoUrl.value;
	if (!url) {
		return;
	}
	rememberBinding(url, {
		provider: "girigiri",
		page: episode.page,
		// A compact "show · line·episode" label: it sits in a small row and only has to
		// identify the pick, the details live in the search itself.
		label: t("room.danmaku.girigiri-binding", {
			show: girigiriShowTitle.value,
			n: line.line,
			ep: episode.number,
		}),
		offset: binding.value?.offset ?? 0,
	});
	closeSearch();
}

function clearBinding() {
	const url = currentVideoUrl.value;
	if (url) {
		forgetBinding(url);
	}
}

const offsetSeconds = computed({
	get: () => binding.value?.offset ?? 0,
	set: value => {
		const url = currentVideoUrl.value;
		const current = binding.value;
		if (url && current) {
			rememberBinding(url, { ...current, offset: value });
		}
	},
});
const offsetLabel = computed(() => {
	const value = offsetSeconds.value;
	return `${value > 0 ? "+" : ""}${value}s`;
});

/** The four block switches act as one chip group. */
const blockedTypes = computed({
	get: () => {
		const settings = store.state.settings;
		const types: string[] = [];
		if (settings.danmakuBlockScroll) {
			types.push("scroll");
		}
		if (settings.danmakuBlockTop) {
			types.push("top");
		}
		if (settings.danmakuBlockBottom) {
			types.push("bottom");
		}
		if (settings.danmakuBlockColored) {
			types.push("colored");
		}
		return types;
	},
	set: (types: unknown) => {
		// biome-ignore lint/nursery/noVueRefAsOperand: this is the raw chip-group payload, not a ref.
		const selected = Array.isArray(types) ? types : [];
		store.commit("settings/UPDATE", {
			danmakuBlockScroll: selected.includes("scroll"),
			danmakuBlockTop: selected.includes("top"),
			danmakuBlockBottom: selected.includes("bottom"),
			danmakuBlockColored: selected.includes("colored"),
		});
	},
});
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: the panel is rendered inside different menus, so its rows cannot carry a single scope id. -->
<style lang="scss">
/* The panel already pads itself; Vuetify's 8px top and bottom on the wrapping list pushed
   the menu past its max height and gave the whole panel a scrollbar. */
.danmaku-panel-list.v-list {
	padding: 0;
}

.danmaku-panel {
	display: flex;
	flex-direction: column;
	gap: 0;
	padding: 6px 10px 8px;
	font-size: 0.85rem;

	/* Both pages share one fixed height: switching tabs never resizes the menu and the
	   pages themselves never scroll; only a search list scrolls inside its own box. */
	.danmaku-page {
		display: flex;
		flex-direction: column;
		/* The rows keep a small gap so adjacent chip groups never look merged. */
		gap: 4px;
		height: 304px;
		overflow: hidden;
	}

	.danmaku-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 34px;
	}

	.danmaku-row-label {
		flex: 0 0 auto;
		white-space: nowrap;
		opacity: 0.9;
	}

	.danmaku-row-value {
		flex: 0 0 auto;
		min-width: 34px;
		text-align: right;
		font-variant-numeric: tabular-nums;
		opacity: 0.6;
	}

	.danmaku-switch {
		flex: 0 0 auto;
		margin: 0;

		.v-switch__track {
			opacity: 0.9;
		}
	}

	.danmaku-chips {
		flex-wrap: wrap;
		justify-content: flex-end;
		/* Wrapped rows of a joined toggle group overlap without a gap. */
		gap: 4px;

		.v-btn {
			min-width: 32px;
			padding: 0 6px;
			text-transform: none;
		}
	}

	/* Six speed stops share one line: numbers only, equal-width blocks. */
	.danmaku-speed-chips {
		flex-wrap: nowrap;
	}

	.danmaku-row-slider {
		flex-direction: column;
		align-items: stretch;
		gap: 0;

		.danmaku-row-top {
			display: flex;
			align-items: center;
			justify-content: space-between;
		}

		.v-slider {
			margin: 0;
		}
	}

	.danmaku-row-stack {
		flex-direction: column;
		align-items: stretch;
		gap: 4px;

		.danmaku-chips {
			justify-content: flex-start;
		}
	}

	/* A slider that shares its row with the label and the value. */
	.danmaku-slider-row {
		.danmaku-inline-slider {
			flex: 1 1 auto;
			margin: 0;
		}
	}

	.danmaku-match-label {
		flex: 1 1 auto;
		min-width: 0;
		text-align: right;
		font-size: 0.72rem;
		line-height: 1.35;
		opacity: 0.75;
	}

	.danmaku-match-empty {
		opacity: 0.55;
	}

	.danmaku-page-switch {
		display: flex;
		justify-content: center;
		padding-bottom: 4px;

		.danmaku-pages {
			width: 100%;

			.v-btn {
				flex: 1 1 0;
				height: 22px;
				min-width: 0;
				text-transform: none;
				letter-spacing: 0.02em;
			}
		}
	}

	.danmaku-section {
		& + .danmaku-section {
			margin-top: 6px;
			padding-top: 6px;
			border-top: 1px solid var(--line);
		}

		.danmaku-section-title {
			margin: 0 0 2px;
			color: var(--signal);
			font-family: var(--font-mono);
			font-size: 0.68rem;
			font-weight: 600;
			letter-spacing: 0.14em;
			opacity: 0.9;
		}
	}

	.danmaku-search-inline {
		display: flex;
		align-items: center;
		gap: 6px;

		.v-text-field {
			flex: 1 1 auto;
			min-width: 0;
		}

		.v-btn {
			flex: 0 0 auto;
		}
	}

	.danmaku-count {
		flex: 0 0 auto;
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		opacity: 0.6;
	}

	.danmaku-slim-field {
		.v-field {
			min-height: 30px;
			font-size: 0.8rem;
		}

		.v-field__input {
			min-height: 28px;
			padding-top: 0;
			padding-bottom: 0;
		}
	}

	.danmaku-sources {
		.danmaku-row {
			min-height: 28px;
		}

		.danmaku-row,
		.danmaku-search-inline {
			margin-top: 4px;
		}
	}

	.danmaku-search-view {
		overflow: hidden;

		.danmaku-search-view-head {
			display: flex;
			align-items: center;
			gap: 6px;
			min-height: 26px;

			.danmaku-search-view-title {
				flex: 1 1 auto;
				min-width: 0;
				overflow: visible;
				white-space: normal;
				line-height: 1.3;
				color: var(--signal);
				font-family: var(--font-mono);
				font-size: 0.7rem;
				letter-spacing: 0.08em;
				opacity: 0.9;
			}
		}

		.danmaku-search-body {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-height: 0;
		}

		.danmaku-search-results {
			flex: 1 1 auto;
			min-height: 0;
			overflow-y: auto;
			background: transparent;

			/* Show an anime's name in full; the list is the one place the full title
			   matters more than a tidy single line. */
			.v-list-item {
				height: auto;
				min-height: 34px;
				padding: 6px 8px;
			}

			.v-list-item-title {
				overflow: visible;
				white-space: normal;
				text-overflow: clip;
				word-break: break-word;
				font-size: 0.82rem;
				line-height: 1.4;
			}

			.v-list-item-subtitle {
				overflow: visible;
				white-space: normal;
				text-overflow: clip;
				font-size: 0.7rem;
				line-height: 1.3;
				opacity: 0.65;
			}
		}
	}

	.danmaku-search-empty {
		margin-top: 6px;
		font-size: 0.75rem;
		opacity: 0.6;
	}

	.danmaku-line-label {
		margin: 4px 0 2px;
		font-size: 0.75rem;
		opacity: 0.7;
	}

	.danmaku-line-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;

		.v-btn {
			min-width: 0;
			padding: 0 8px;
			text-transform: none;
		}
	}

	.danmaku-unavailable {
		opacity: 0.7;
		padding: 4px 0;
	}
}
</style>
