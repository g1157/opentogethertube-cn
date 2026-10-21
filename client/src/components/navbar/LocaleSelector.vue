<template>
	<v-select
		class="locale-selector"
		variant="outlined"
		density="compact"
		hide-details
		:menu-props="{
			minWidth: 160,
			maxWidth: 320,
			maxHeight: 320,
			location: 'bottom end',
			offset: 6,
			scrollStrategy: 'reposition',
		}"
		:menu="menuOpen"
		@update:menu="menuOpen = $event"
		:aria-label="$t('common.language')"
		item-title="text"
		:items="locales"
		v-model="locale"
	>
		<template #item="{ props: itemProps, item }">
			<v-list-item
				v-bind="itemProps"
				:subtitle="item.raw.partial ? $t('common.partial-translation') : undefined"
			/>
		</template>
	</v-select>
</template>

<script lang="ts" setup>
import { onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { loadLanguageAsync } from "@/i18n";
import { useStore } from "@/store";

// English and Simplified Chinese are complete; the other translations only cover a part of
// the interface, which the menu says out loud instead of pretending otherwise.
const locales = [
	{
		text: "English",
		value: "en",
		partial: false,
	},
	{
		text: "Deutsch",
		value: "de",
		partial: true,
	},
	{
		text: "Français",
		value: "fr",
		partial: true,
	},
	{
		text: "Русский",
		value: "ru",
		partial: true,
	},
	{
		text: "Español",
		value: "es",
		partial: true,
	},
	{
		text: "Português",
		value: "pt-br",
		partial: true,
	},
	{
		text: "简体中文",
		value: "zh-CN",
		partial: false,
	},
];

const store = useStore();
const route = useRoute();
const menuOpen = ref(false);
watch([() => store.state.fullscreen, () => route.fullPath], () => {
	menuOpen.value = false;
});
const locale = ref(store.state.settings.locale);

const setLocale = async (locale: string) => {
	await loadLanguageAsync(locale);
	store.commit("settings/UPDATE", { locale });
};

watch(locale, (newLocale: string) => {
	setLocale(newLocale);
});

// HACK: because for some reason, the locale ref is not updated when the store is updated
const unsubscribe = store.subscribe(mutation => {
	if (mutation.type === "settings/UPDATE") {
		locale.value = store.state.settings.locale;
	}
});
onUnmounted(unsubscribe);
</script>

<style scoped>
.locale-selector {
	width: 132px;
	flex: 0 0 132px;
	font-size: 0.85rem;
}
</style>
