<template>
	<div class="emoji-panel" data-cy="chat-emoji-panel">
		<div class="emoji-quick" role="group" :aria-label="$t('chat.emoji.quick')">
			<button
				v-for="emoji in EMOJI_QUICK"
				:key="`quick-${emoji}`"
				type="button"
				class="emoji-button"
				data-cy="chat-emoji-quick"
				@mousedown.prevent
				@click="emit('select', emoji)"
			>
				{{ emoji }}
			</button>
		</div>
		<div v-for="group in EMOJI_GROUPS" :key="group.id" class="emoji-group">
			<p class="emoji-group-title">{{ $t(`chat.emoji.groups.${group.id}`) }}</p>
			<div class="emoji-grid" role="group" :aria-label="$t(`chat.emoji.groups.${group.id}`)">
				<button
					v-for="emoji in group.emoji"
					:key="`${group.id}-${emoji}`"
					type="button"
					class="emoji-button"
					data-cy="chat-emoji-item"
					@mousedown.prevent
					@click="emit('select', emoji)"
				>
					{{ emoji }}
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { EMOJI_GROUPS, EMOJI_QUICK } from "@/util/chat-emoji";

const emit = defineEmits<{ select: [emoji: string] }>();
</script>

<style lang="scss" scoped>
.emoji-panel {
	display: flex;
	flex-direction: column;
	gap: 10px;
	width: min(336px, 84vw);
	max-height: min(320px, 52vh);
	overflow-y: auto;
	padding: 10px;
	background: rgb(var(--v-theme-surface));
}

.emoji-quick {
	display: grid;
	grid-template-columns: repeat(8, 1fr);
	gap: 2px;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--line);
}

.emoji-group-title {
	margin: 0 0 4px;
	color: var(--muted-foreground);
	font-size: 0.75rem;
}

.emoji-grid {
	display: grid;
	grid-template-columns: repeat(8, 1fr);
	gap: 2px;
}

// The composer keeps focus while an emoji is picked, so these never take a caret.
.emoji-button {
	padding: 4px 0;
	border: none;
	border-radius: 6px;
	background: none;
	font-size: 1.15rem;
	line-height: 1.3;
	cursor: pointer;

	&:hover,
	&:focus-visible {
		background: rgba(var(--v-theme-on-surface), 0.12);
	}
}
</style>
