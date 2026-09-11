<template>
	<v-btn
		variant="text"
		icon
		v-if="!isMobile && !store.state.fullscreen"
		@click="rotateRoomLayout"
		class="media-control"
		:aria-label="$t('room.theater-mode')"
	>
		<v-icon
			v-if="store.state.settings.roomLayout === 'theater'"
			style="transform: scaleX(180%)"
			:icon="mdiSquareOutline"
		/>
		<v-icon v-else style="transform: scaleX(130%)" :icon="mdiSquareOutline" />
		<v-tooltip activator="parent" location="top" v-model="layoutTooltip" :disabled="!canHover">
			<span>{{
				$t(
					store.state.settings.roomLayout === "theater"
						? "room.default-layout"
						: "room.theater-mode",
				)
			}}</span>
		</v-tooltip>
	</v-btn>
	<v-btn
		variant="text"
		icon
		@click="toggleFullscreen()"
		class="media-control"
		:aria-label="$t('room.toggle-fullscreen')"
	>
		<v-icon :icon="store.state.fullscreen ? mdiFullscreenExit : mdiFullscreen" />
		<v-tooltip
			activator="parent"
			location="top"
			v-model="fullscreenTooltip"
			:disabled="!canHover"
		>
			<span>{{ $t("room.toggle-fullscreen") }}</span>
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { mdiSquareOutline, mdiFullscreen, mdiFullscreenExit } from "@mdi/js";
import { inject, shallowRef, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { useStore } from "@/store";
import { RoomLayoutMode } from "@/stores/settings";
import { PlayerFullscreenKey } from "@/util/player-fullscreen";
import { PHONE_MAX_QUERY } from "@/util/breakpoints";

const store = useStore();
const fullscreen = inject(PlayerFullscreenKey);
const layoutTooltip = shallowRef(false);
const fullscreenTooltip = shallowRef(false);
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
const isMobile = useMediaQuery(PHONE_MAX_QUERY);

watch([isMobile, () => store.state.fullscreen], () => {
	layoutTooltip.value = false;
	fullscreenTooltip.value = false;
});

function toggleFullscreen() {
	fullscreenTooltip.value = false;
	void fullscreen?.toggle();
}

function rotateRoomLayout() {
	const layouts = [RoomLayoutMode.default, RoomLayoutMode.theater];
	const newLayout =
		layouts[(layouts.indexOf(store.state.settings.roomLayout) + 1) % layouts.length];
	store.commit("settings/UPDATE", { roomLayout: newLayout });
	layoutTooltip.value = false;
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";
</style>
