<template>
	<header class="page-header">
		<div class="page-heading">
			<p v-if="eyebrow" class="page-eyebrow">{{ eyebrow }}</p>
			<h1 class="page-title">{{ title }}</h1>
			<p v-if="description" class="page-description">{{ description }}</p>
		</div>
		<div v-if="$slots.default" class="page-actions">
			<slot></slot>
		</div>
	</header>
</template>

<script setup lang="ts">
defineProps<{
	eyebrow?: string;
	title: string;
	description?: string;
}>();
</script>

<style scoped>
.page-header {
	display: flex;
	align-items: flex-end;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 1.25rem;
	margin-bottom: 2rem;
}

.page-heading {
	min-width: 0;
}

.page-eyebrow {
	margin: 0 0 0.65rem;
	color: var(--signal);
	font-family: var(--font-mono);
	font-size: 0.72rem;
	font-weight: 600;
	letter-spacing: 0.16em;
	line-height: 1.5;
	text-transform: uppercase;
}

.page-title {
	margin: 0;
	border-left: 4px solid var(--primary);
	padding-left: 1rem;
	color: var(--foreground);
	font-family: var(--font-display);
	font-size: clamp(1.8rem, 4vw, 2.75rem);
	font-weight: 700;
	line-height: 1.25;
	overflow-wrap: anywhere;
}

.page-description {
	max-width: 42rem;
	margin: 1rem 0 0;
	color: var(--muted-foreground);
	line-height: 1.7;
}

.page-actions {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.75rem;
}
</style>
