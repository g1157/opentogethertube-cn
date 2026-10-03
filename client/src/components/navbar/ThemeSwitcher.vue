<template>
	<v-menu
		v-model="open"
		location="bottom end"
		:offset="8"
		:max-width="280"
		:max-height="380"
		scroll-strategy="reposition"
	>
		<template #activator="{ props }">
			<v-btn
				icon
				variant="text"
				v-bind="props"
				data-cy="theme-switcher"
				:aria-label="$t('client-settings.theme')"
			>
				<v-icon :icon="mdiThemeLightDark" />
				<v-tooltip activator="parent" location="bottom" :disabled="!canHover || open">
					{{ $t("client-settings.theme") }}
				</v-tooltip>
			</v-btn>
		</template>
		<v-list density="compact">
			<!-- Each row previews its own palette, so the list reads as swatches rather than
			     colour names. -->
			<v-theme-provider
				v-for="item in themes"
				:key="item.value"
				:theme="item.value"
				with-background
			>
				<v-list-item
					:active="item.value === theme"
					:data-cy="`theme-option-${item.value}`"
					@click="select(item.value)"
				>
					<v-list-item-title>{{ item.title }}</v-list-item-title>
					<template #append>
						<v-icon v-if="item.value === theme" :icon="mdiCheck" size="small" />
					</template>
				</v-list-item>
			</v-theme-provider>
		</v-list>
	</v-menu>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { mdiCheck, mdiThemeLightDark } from "@mdi/js";
import { useStore } from "@/store";
import { Theme } from "@/stores/settings";
import { enumKeys } from "@/util/misc";

const store = useStore();
const { t } = useI18n();
const open = ref(false);
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
const theme = computed(() => store.state.settings.theme);
const themes = computed(() =>
	enumKeys(Theme).map(value => ({
		// biome-ignore lint/nursery/noVueRefAsOperand: value is an enum member, not a Vue ref.
		title: t(`client-settings.themes.${value}`),
		value,
	})),
);

function select(value: Theme) {
	store.commit("settings/UPDATE", { theme: value });
	open.value = false;
}
</script>
