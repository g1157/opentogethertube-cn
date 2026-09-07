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
		<v-tooltip activator="parent" location="bottom" v-model="layoutTooltip">
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
		<v-tooltip activator="parent" location="bottom">
			<span>{{ $t("room.toggle-fullscreen") }}</span>
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { mdiSquareOutline, mdiFullscreen, mdiFullscreenExit } from "@mdi/js";
import { computed, inject, shallowRef } from "vue";
import { useStore } from "@/store";
import { RoomLayoutMode } from "@/stores/settings";
import { PlayerFullscreenKey } from "@/util/player-fullscreen";

const store = useStore();
const fullscreen = inject(PlayerFullscreenKey);
const layoutTooltip = shallowRef(false);

const isMobile = computed(() => {
	return window.matchMedia("only screen and (max-width: 760px)").matches;
});

function toggleFullscreen() {
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
