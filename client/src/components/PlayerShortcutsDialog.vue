<template>
	<v-dialog
		:model-value="modelValue"
		@update:model-value="emit('update:modelValue', $event)"
		max-width="560"
		scrollable
	>
		<v-card>
			<v-card-title>{{ $t("player.shortcuts.title") }}</v-card-title>
			<v-card-text>
				<p class="shortcut-intro">{{ $t("player.shortcuts.gestures") }}</p>
				<p class="shortcut-intro">{{ $t("player.shortcuts.chat-hint") }}</p>
				<table class="player-shortcuts-table">
					<tbody>
						<tr v-for="[keys, label] in shortcuts" :key="label">
							<td>
								<kbd>{{ keys }}</kbd>
							</td>
							<td>{{ $t(`player.shortcuts.${label}`) }}</td>
						</tr>
					</tbody>
				</table>
				<p class="shortcut-intro">{{ $t("player.shortcuts.scope") }}</p>
			</v-card-text>
			<v-card-actions>
				<v-spacer />
				<v-btn @click="emit('update:modelValue', false)">{{ $t("common.close") }}</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean }>();
const emit = defineEmits(["update:modelValue"]);
const shortcuts = [
	["Space / K", "play-pause"],
	["← / →", "seek-five"],
	["J / L", "seek-ten"],
	["↑ / ↓", "volume"],
	["M", "mute"],
	["F", "fullscreen"],
	["Esc", "escape"],
	["T", "chat"],
	["Home", "start"],
	["End", "skip"],
	["?", "help"],
];
</script>

<style scoped>
.player-shortcuts-table {
	width: 100%;
	border-collapse: collapse;
}
.player-shortcuts-table td {
	padding: 6px 8px;
}
.player-shortcuts-table td:first-child {
	white-space: nowrap;
}
.shortcut-intro {
	margin: 12px 0;
	line-height: 1.6;
}
</style>
