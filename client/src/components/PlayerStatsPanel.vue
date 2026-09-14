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
 * Floats over the picture the way YouTube's "stats for nerds" does: pinned to the
 * top-left, translucent, and pointer-events none so it never blocks the video or
 * the playback gestures underneath. Only the close button takes clicks.
 */
.player-stats {
	position: absolute;
	top: 0.5rem;
	left: 0.5rem;
	z-index: 4;
	max-width: min(22rem, calc(100% - 1rem));
	max-height: calc(100% - 1rem);
	overflow: hidden;
	padding: 0.4rem 0.55rem 0.5rem;
	border-radius: 0.4rem;
	background: rgb(0 0 0 / 72%);
	color: white;
	font-size: 0.72rem;
	line-height: 1.45;
	font-variant-numeric: tabular-nums;
	pointer-events: none;
}

.player-stats-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.5rem;
	font-weight: 600;
	opacity: 0.9;
}

.player-stats-close {
	pointer-events: auto;
	border: none;
	background: transparent;
	color: inherit;
	font-size: 0.95rem;
	line-height: 1;
	padding: 0 0.15rem;
	cursor: pointer;
	opacity: 0.7;
}

.player-stats-close:hover {
	opacity: 1;
}

.player-stats-section {
	margin-top: 0.3rem;
}

.player-stats-section-title {
	margin-top: 0.25rem;
	opacity: 0.55;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	font-size: 0.62rem;
}

.player-stats-row {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
}

.player-stats-label {
	flex: 0 0 5.4rem;
	opacity: 0.7;
}

.player-stats-value {
	flex: 1 1 auto;
	overflow-wrap: anywhere;
}
</style>
