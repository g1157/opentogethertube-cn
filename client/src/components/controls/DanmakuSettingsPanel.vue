<template>
	<div class="danmaku-panel">
		<div v-if="!danmakuAvailable" class="danmaku-unavailable">
			{{ $t("room.danmaku.unavailable") }}
		</div>
		<div class="danmaku-row">
			<span class="danmaku-row-label">{{ $t("room.danmaku.enable") }}</span>
			<v-switch
				v-model="danmakuEnabled"
				color="primary"
				density="compact"
				hide-details
				class="danmaku-switch"
				data-cy="danmaku-enabled"
			/>
		</div>
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
				class="danmaku-chips"
			>
				<v-btn
					v-for="speed in DANMAKU_SPEED_OPTIONS"
					:key="speed"
					:value="speed"
					size="x-small"
					:data-cy="`danmaku-speed-${speed}`"
				>
					{{ speed }}×
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
		<div class="danmaku-row danmaku-more-row">
			<v-btn
				variant="text"
				size="small"
				block
				class="danmaku-more-toggle"
				data-cy="danmaku-more-settings"
				@click="moreOpen = !moreOpen"
			>
				<v-icon :icon="moreOpen ? mdiChevronUp : mdiChevronDown" start />
				{{ $t("room.danmaku.more-settings") }}
			</v-btn>
		</div>
		<v-expand-transition>
			<div v-show="moreOpen" class="danmaku-more">
				<div class="danmaku-row danmaku-row-stack">
					<span class="danmaku-row-label">{{ $t("room.danmaku.api-base") }}</span>
					<v-text-field
						v-model="danmakuApiBase"
						density="compact"
						variant="outlined"
						hide-details
						:placeholder="$t('room.danmaku.api-base-placeholder')"
						data-cy="danmaku-api-base"
					/>
					<div class="danmaku-match-row">
						<span v-if="binding" class="danmaku-match-label">
							{{ $t("room.danmaku.bound", { title: binding.label }) }}
						</span>
						<span v-else class="danmaku-match-label danmaku-match-empty">
							{{ $t("room.danmaku.not-bound") }}
						</span>
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
					<div class="danmaku-match-actions">
						<v-btn
							size="x-small"
							variant="tonal"
							:disabled="!danmakuApiBase || !currentVideoUrl"
							@click="searchOpen = true"
							data-cy="danmaku-search-open"
						>
							{{ $t("room.danmaku.search-danmaku") }}
						</v-btn>
						<v-btn
							size="x-small"
							variant="tonal"
							:disabled="!currentVideoUrl"
							@click="girigiriOpen = true"
							data-cy="danmaku-girigiri-open"
						>
							{{ $t("room.danmaku.girigiri-search") }}
						</v-btn>
					</div>
				</div>
				<div v-if="binding" class="danmaku-row danmaku-row-slider">
					<div class="danmaku-row-top">
						<span class="danmaku-row-label">{{ $t("room.danmaku.offset") }}</span>
						<span class="danmaku-row-value">{{ offsetLabel }}</span>
					</div>
					<v-slider
						v-model="offsetSeconds"
						:min="-60"
						:max="60"
						:step="0.5"
						color="primary"
						density="compact"
						hide-details
						data-cy="danmaku-offset"
					/>
					<div class="danmaku-row-hint">{{ $t("room.danmaku.offset-hint") }}</div>
				</div>
			</div>
		</v-expand-transition>

		<v-dialog v-model="searchOpen" max-width="440">
			<v-card>
				<v-card-title class="danmaku-search-title">
					{{ $t("room.danmaku.search-title") }}
				</v-card-title>
				<v-card-text>
					<div class="danmaku-search-bar">
						<v-text-field
							v-model="keyword"
							density="compact"
							variant="outlined"
							hide-details
							:placeholder="$t('room.danmaku.search-placeholder')"
							@keyup.enter="runSearch"
						/>
						<v-btn size="small" variant="tonal" :loading="searching" @click="runSearch">
							{{ $t("room.danmaku.search-action") }}
						</v-btn>
					</div>
					<v-list v-if="results.length" density="compact" class="danmaku-search-list">
						<v-list-item
							v-for="item in results"
							:key="String(item.animeId)"
							:title="item.title"
							:subtitle="item.source"
							@click="selectAnime(item)"
						/>
					</v-list>
					<v-list v-if="episodes.length" density="compact" class="danmaku-search-list">
						<v-list-item
							v-for="episode in episodes"
							:key="String(episode.episodeId)"
							:title="episode.title"
							@click="bindEpisode(episode)"
						/>
					</v-list>
					<div v-if="searchEmpty && !searching" class="danmaku-search-empty">
						{{ $t("room.danmaku.search-empty") }}
					</div>
				</v-card-text>
			</v-card>
		</v-dialog>

		<v-dialog v-model="girigiriOpen" max-width="440">
			<v-card>
				<v-card-title class="danmaku-search-title">
					{{ $t("room.danmaku.girigiri-title") }}
				</v-card-title>
				<v-card-text>
					<div class="danmaku-search-bar">
						<v-text-field
							v-model="girigiriKeyword"
							density="compact"
							variant="outlined"
							hide-details
							:placeholder="$t('room.danmaku.girigiri-placeholder')"
							@keyup.enter="runGirigiriSearch"
						/>
						<v-btn
							size="small"
							variant="tonal"
							:loading="girigiriSearching"
							@click="runGirigiriSearch"
						>
							{{ $t("room.danmaku.search-action") }}
						</v-btn>
					</div>
					<v-list
						v-if="girigiriResults.length"
						density="compact"
						class="danmaku-search-list"
					>
						<v-list-item
							v-for="item in girigiriResults"
							:key="item.id"
							:title="item.name"
							@click="selectGirigiriShow(item)"
						/>
					</v-list>
					<div v-if="girigiriLines.length" class="danmaku-episodes">
						<div v-for="line in girigiriLines" :key="line.line" class="danmaku-line">
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
									{{ $t("room.danmaku.girigiri-episode", { n: episode.number }) }}
								</v-btn>
							</div>
						</div>
					</div>
					<div v-if="girigiriEmpty && !girigiriSearching" class="danmaku-search-empty">
						{{ $t("room.danmaku.girigiri-empty") }}
					</div>
				</v-card-text>
			</v-card>
		</v-dialog>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
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
const danmakuEnabled = computed({
	get: () => store.state.settings.danmakuEnabled,
	set: value => store.commit("settings/UPDATE", { danmakuEnabled: value }),
});
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
 * from. The binding belongs to the video the layer is currently playing.
 */
const danmakuApiBase = computed({
	get: () => store.state.settings.danmakuApiBase,
	set: value => store.commit("settings/UPDATE", { danmakuApiBase: value }),
});
const binding = computed(() => {
	const url = currentVideoUrl.value;
	return url ? getBinding(url) : null;
});

const searchOpen = ref(false);
const keyword = ref("");
const searching = ref(false);
const results = ref<DanmakuSearchResult[]>([]);
const episodes = ref<DanmakuEpisode[]>([]);
const searchEmpty = ref(false);
let selectedAnimeTitle = "";

async function runSearch() {
	searching.value = true;
	try {
		episodes.value = [];
		results.value = await searchAnime(keyword.value);
		searchEmpty.value = results.value.length === 0;
	} finally {
		searching.value = false;
	}
}

async function selectAnime(item: DanmakuSearchResult) {
	selectedAnimeTitle = item.title;
	episodes.value = await fetchEpisodes(item.animeId);
	searchEmpty.value = episodes.value.length === 0;
}

function bindEpisode(episode: DanmakuEpisode) {
	const url = currentVideoUrl.value;
	if (!url) {
		return;
	}
	const label = [selectedAnimeTitle, episode.title].filter(Boolean).join(" · ");
	rememberBinding(url, {
		provider: "danmu-api",
		episodeId: episode.episodeId,
		label,
		offset: binding.value?.offset ?? 0,
	});
	searchOpen.value = false;
}

const girigiriOpen = ref(false);
const girigiriKeyword = ref("");
const girigiriSearching = ref(false);
const girigiriResults = ref<GirigiriSearchResult[]>([]);
const girigiriLines = ref<GirigiriLine[]>([]);
const girigiriEmpty = ref(false);
let girigiriShowTitle = "";

async function runGirigiriSearch() {
	girigiriSearching.value = true;
	try {
		girigiriLines.value = [];
		girigiriResults.value = await searchGirigiri(girigiriKeyword.value);
		girigiriEmpty.value = girigiriResults.value.length === 0;
	} finally {
		girigiriSearching.value = false;
	}
}

async function selectGirigiriShow(item: GirigiriSearchResult) {
	girigiriShowTitle = item.name;
	girigiriLines.value = await fetchGirigiriEpisodes(item.id);
	girigiriEmpty.value = girigiriLines.value.length === 0;
}

function bindGirigiriEpisode(line: GirigiriLine, episode: GirigiriEpisode) {
	const url = currentVideoUrl.value;
	if (!url) {
		return;
	}
	const episodeLabel = t("room.danmaku.girigiri-episode", { n: episode.number });
	rememberBinding(url, {
		provider: "girigiri",
		page: episode.page,
		label: [girigiriShowTitle, `线路 ${line.line}`, episodeLabel].filter(Boolean).join(" · "),
		offset: binding.value?.offset ?? 0,
	});
	girigiriOpen.value = false;
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
.danmaku-panel {
	display: flex;
	flex-direction: column;
	gap: 0;
	padding: 6px 10px 8px;
	font-size: 0.8rem;

	.danmaku-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 28px;
	}

	.danmaku-row-label {
		white-space: nowrap;
		opacity: 0.9;
	}

	.danmaku-row-value {
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

		.v-btn {
			min-width: 0;
			padding: 0 6px;
			text-transform: none;
		}
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

	.danmaku-match-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;

		.danmaku-match-label {
			flex: 1 1 auto;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			opacity: 0.9;
		}

		.danmaku-match-empty {
			opacity: 0.55;
		}
	}

	.danmaku-search-title {
		font-size: 1rem;
		padding-bottom: 4px;
	}

	.danmaku-search-bar {
		display: flex;
		align-items: flex-start;
		gap: 8px;

		.v-btn {
			flex: 0 0 auto;
			margin-top: 1px;
		}
	}

	.danmaku-search-list {
		margin-top: 8px;
		max-height: 260px;
		overflow-y: auto;
		background: transparent;
	}

	.danmaku-search-empty {
		margin-top: 10px;
		opacity: 0.6;
	}

	.danmaku-more-row {
		justify-content: center;
	}

	.danmaku-more-toggle {
		justify-content: center;
		text-transform: none;
		letter-spacing: normal;
		opacity: 0.85;
	}

	.danmaku-match-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.danmaku-row-hint {
		margin-top: 2px;
		font-size: 0.75rem;
		opacity: 0.6;
	}

	.danmaku-episodes {
		margin-top: 10px;
		max-height: 260px;
		overflow-y: auto;
	}

	.danmaku-line-label {
		margin: 6px 0 4px;
		font-size: 0.8rem;
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
