<template>
	<v-dialog
		:model-value="modelValue"
		@update:model-value="emit('update:modelValue', $event)"
		max-width="640"
		scrollable
	>
		<v-card>
			<v-card-title>{{ $t("player.stats.title") }}</v-card-title>
			<v-card-text class="player-stats">
				<div v-for="section in sections" :key="section.titleKey" class="stats-section">
					<h3 class="stats-section-title">{{ $t(section.titleKey) }}</h3>
					<table class="stats-table">
						<tbody>
							<tr v-for="row in section.rows" :key="row.labelKey">
								<th scope="row">{{ $t(row.labelKey) }}</th>
								<td>
									{{
										row.value ??
										(row.valueKey ? $t(row.valueKey, row.params ?? {}) : "—")
									}}
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p class="stats-hint">{{ $t("player.stats.hint") }}</p>
			</v-card-text>
			<v-card-actions>
				<v-spacer />
				<v-btn @click="emit('update:modelValue', false)">{{ $t("common.close") }}</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script lang="ts" setup>
import { usePlayerStats } from "./composables/player-stats";

const props = defineProps<{
	modelValue: boolean;
	/** The live media element, when the current player owns one. */
	videoElement?: HTMLVideoElement;
}>();
const emit = defineEmits(["update:modelValue"]);

// Sampling only runs while the panel is open.
const { sections } = usePlayerStats(
	() => props.videoElement,
	() => props.modelValue,
);
</script>

<style scoped>
.stats-section + .stats-section {
	margin-top: 16px;
}

.stats-section-title {
	font-size: 0.85rem;
	font-weight: 600;
	text-transform: none;
	opacity: 0.7;
	margin: 0 0 4px;
}

.stats-table {
	width: 100%;
	border-collapse: collapse;
}

.stats-table th,
.stats-table td {
	padding: 5px 8px;
	text-align: left;
	vertical-align: top;
	font-weight: 400;
	line-height: 1.5;
}

.stats-table th {
	white-space: nowrap;
	opacity: 0.75;
	width: 40%;
}

.stats-table td {
	word-break: break-all;
	font-variant-numeric: tabular-nums;
}

.stats-hint {
	margin: 16px 0 0;
	opacity: 0.6;
	font-size: 0.8rem;
	line-height: 1.5;
}
</style>
