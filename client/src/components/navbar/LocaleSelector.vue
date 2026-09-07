<template>
	<v-select
		variant="solo"
		style="margin-top: 5px; width: 140px"
		:aria-label="$t('common.language')"
		item-title="text"
		:items="locales"
		v-model="locale"
	/>
</template>

<script lang="ts" setup>
import { ref, watch } from "vue";
import { loadLanguageAsync } from "@/i18n";
import { useStore } from "@/store";

const locales = [
	{
		text: "English",
		value: "en",
	},
	{
		text: "Deutsch",
		value: "de",
	},
	{
		text: "Français",
		value: "fr",
	},
	{
		text: "Русский",
		value: "ru",
	},
	{
		text: "Español",
		value: "es",
	},
	{
		text: "Português",
		value: "pt-br",
	},
	{
		text: "简体中文",
		value: "zh-CN",
	},
];

const store = useStore();
const locale = ref(store.state.settings.locale);

const setLocale = async (locale: string) => {
	await loadLanguageAsync(locale);
	store.commit("settings/UPDATE", { locale });
};

watch(locale, (newLocale: string) => {
	setLocale(newLocale);
});

// HACK: because for some reason, the locale ref is not updated when the store is updated
store.subscribe(mutation => {
	if (mutation.type === "settings/UPDATE") {
		locale.value = store.state.settings.locale;
	}
});
</script>
