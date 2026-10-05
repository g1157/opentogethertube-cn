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
		<!-- The same glyph girigiri's player uses: the character, struck through when off. -->
		<span class="danmaku-toggle-glyph" :class="{ 'is-off': !enabled }" aria-hidden="true"
			>弹</span
		>
		<v-tooltip activator="parent" location="top" :disabled="!canHover">
			{{ $t("room.danmaku.title") }}
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { useMediaQuery } from "@vueuse/core";
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

.danmaku-toggle-glyph {
	position: relative;
	font-size: 1.05rem;
	font-weight: 600;
	line-height: 1;

	&.is-off::after {
		content: "";
		position: absolute;
		left: -3px;
		right: -3px;
		top: 50%;
		height: 2px;
		border-radius: 1px;
		background: currentColor;
		transform: rotate(-45deg);
		transform-origin: center;
	}
}
</style>
