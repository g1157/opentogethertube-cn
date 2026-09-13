<template>
	<div class="skeleton" :class="variant" aria-hidden="true">
		<div v-if="variant !== 'row'" class="skeleton-thumb"></div>
		<div class="skeleton-body">
			<div class="skeleton-line" style="width: 35%"></div>
			<div class="skeleton-line strong" style="width: 75%"></div>
			<div class="skeleton-line" style="width: 92%"></div>
			<div class="skeleton-line" style="width: 55%"></div>
		</div>
	</div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ variant?: "card" | "row" }>(), { variant: "card" });
</script>

<style scoped>
.skeleton {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	border: 1px solid var(--line);
	border-radius: 0.75rem;
	background: var(--card);
}

.skeleton.row {
	flex-direction: row;
	align-items: center;
	padding: 1.25rem;
}

.skeleton-thumb {
	flex: none;
	aspect-ratio: 1.8;
	border-bottom: 1px solid var(--line);
	background: var(--surface-2);
}

.skeleton-body {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 0.7rem;
	padding: 1rem;
}

.skeleton.row .skeleton-body {
	padding: 0;
}

.skeleton-line {
	height: 0.9em;
	border-radius: 0.3em;
	background: var(--surface-2);
}

.skeleton-line.strong {
	height: 1.2em;
}

.skeleton-thumb,
.skeleton-line {
	animation: skeleton-pulse 1.6s ease-in-out infinite;
}

@keyframes skeleton-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.55;
	}
}

@media (prefers-reduced-motion: reduce) {
	.skeleton-thumb,
	.skeleton-line {
		animation: none;
	}
}
</style>
