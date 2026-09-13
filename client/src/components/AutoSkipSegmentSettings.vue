<template>
	<v-select
		v-model="model"
		:items="items"
		item-title="title"
		item-value="value"
		:loading="loading"
		:disabled="disabled"
		:label="$t('room-settings.auto-skip-text')"
		chips
		multiple
		data-cy="input-auto-skip"
	/>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ALL_SKIP_CATEGORIES } from "ott-common";
import type { Category } from "sponsorblock-api";

const { t } = useI18n();
const model = defineModel<Category[]>();
defineProps<{
	loading?: boolean;
	disabled?: boolean;
}>();

const items = computed(() =>
	ALL_SKIP_CATEGORIES.map(category => ({
		// biome-ignore lint/nursery/noVueRefAsOperand: category is a SponsorBlock name, not a Vue ref.
		title: t(`room-settings.auto-skip-text-${category}`),
		value: category,
	})),
);
</script>
