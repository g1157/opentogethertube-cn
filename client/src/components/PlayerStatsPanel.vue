<template>
	<div class="player-stats" data-cy="player-stats-panel">
		<div class="player-stats-header">
			<span>{{ $t("player.stats.title") }}</span>
			<button
				type="button"
				class="player-stats-close"
				:aria-label="$t('common.close')"
				@click="emit('close')"
			>
				×
			</button>
		</div>
		<div v-for="section in sections" :key="section.titleKey" class="player-stats-section">
			<div class="player-stats-section-title">{{ $t(section.titleKey) }}</div>
			<div v-for="row in section.rows" :key="row.labelKey" class="player-stats-row">
				<span class="player-stats-label">{{ $t(row.labelKey) }}</span>
				<span class="player-stats-value">
					{{ row.value ?? (row.valueKey ? $t(row.valueKey, row.params ?? {}) : "—") }}
				</span>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { usePlayerStats } from "./composables/player-stats";

const props = defineProps<{
	/** The live media element, when the current player owns one. */
	videoElement?: HTMLVideoElement;
}>();
const emit = defineEmits(["close"]);

// Sampling only runs while the panel is mounted.
const { sections } = usePlayerStats(
	() => props.videoElement,
	() => true,
);
</script>

<style scoped>
/*
 * Floats over the picture the way YouTube's "stats for nerds" and Bilibili's 统计信息 do:
 * pinned to the top-left, narrow enough to leave most of the frame uncovered, and
 * pointer-events none so it never blocks the video or the playback gestures underneath.
 * Only the close button takes clicks.
 */
.player-stats {
	position: absolute;
	/* Clear the "now playing" bar so the two translucent panels never overlap. */
	top: calc(max(12px, env(safe-area-inset-top)) + 44px);
	left: 0.5rem;
	z-index: 4;
	/* A glance, not a page. The label column and the values are the only things that
	   need to fit; anything wider would start covering the picture it describes. */
	max-width: min(15.5rem, calc(100% - 1rem));
	max-height: calc(100% - 1rem);
	overflow: hidden;
	padding: 0.3rem 0.45rem 0.35rem;
	border-radius: 3px;
	/* Both references keep the video visible behind their numbers; the blur does the
	   legibility work that a dark fill would otherwise have to do. */
	background: rgb(0 0 0 / 30%);
	backdrop-filter: blur(5px) saturate(120%);
	box-shadow: inset 0 0 0 1px rgb(255 255 255 / 10%);
	color: rgb(255 255 255 / 96%);
	/* A translucent fill cannot reach AA contrast over a white frame on its own, so the
	   text carries its own outline the way subtitles do. */
	text-shadow: 0 0 3px rgb(0 0 0 / 85%), 0 1px 2px rgb(0 0 0 / 70%);
	font-size: 0.7rem;
	line-height: 1.35;
	font-variant-numeric: tabular-nums;
	pointer-events: none;
}

.player-stats-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.4rem;
	font-weight: 600;
	opacity: 0.95;
}

.player-stats-close {
	pointer-events: auto;
	border: none;
	background: transparent;
	color: inherit;
	font-size: 0.9rem;
	line-height: 1;
	padding: 0 0.1rem;
	cursor: pointer;
	opacity: 0.7;
}

.player-stats-close:hover {
	opacity: 1;
}

.player-stats-section {
	margin-top: 0.25rem;
}

.player-stats-section-title {
	margin-top: 0.2rem;
	opacity: 0.55;
	text-transform: uppercase;
	letter-spacing: 0.03em;
	font-size: 0.58rem;
}

.player-stats-row {
	display: flex;
	align-items: baseline;
	gap: 0.35rem;
}

.player-stats-label {
	flex: 0 0 4.6rem;
	opacity: 0.75;
}

.player-stats-value {
	flex: 1 1 auto;
	overflow-wrap: anywhere;
}

/* On phones the title bar, subtitles and controls crowd the same corner; sit above the
   controls instead, where nothing else is drawn. The panel also narrows further, so the
   picture keeps most of the screen even with the details open. */
@media (max-width: 760px) {
	.player-stats {
		top: auto;
		bottom: calc(var(--player-controls-height, 90px) + 0.5rem);
		max-width: min(13.5rem, calc(100% - 1.25rem));
		max-height: calc(100% - var(--player-controls-height, 90px) - 1rem);
	}
}
</style>
