<template>
	<v-btn
		variant="text"
		icon
		:disabled="!available"
		class="media-control"
		data-cy="danmaku-toggle"
		:aria-label="$t('room.danmaku.title')"
		@click="toggleDanmaku()"
	>
		<v-icon :icon="enabled ? mdiCommentMultiple : mdiCommentMultipleOutline" />
		<v-tooltip activator="parent" location="top" :disabled="!canHover">
			{{ $t("room.danmaku.title") }}
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { mdiCommentMultiple, mdiCommentMultipleOutline } from "@mdi/js";
import { useDanmaku } from "../composables";
import { useStore } from "@/store";

const store = useStore();
const { available } = useDanmaku();
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");

const enabled = computed(() => store.state.settings.danmakuEnabled);

function toggleDanmaku() {
	store.commit("settings/UPDATE", { danmakuEnabled: !enabled.value });
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";
</style>
