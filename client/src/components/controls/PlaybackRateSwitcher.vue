<template>
	<v-menu
		v-model="menuOpen"
		location="top end"
		origin="auto"
		:offset="8"
		:min-width="96"
		:max-width="200"
		:max-height="320"
		scroll-strategy="reposition"
		transition="fade-transition"
		:disabled="!supported || !granted('playback.speed')"
	>
		<template #activator="{ props }">
			<v-btn
				v-bind="props"
				variant="text"
				class="media-control"
				data-cy="playback-rate-toggle"
				:aria-label="$t('room.playback-speed')"
				:disabled="!supported || !granted('playback.speed')"
			>
				{{ formatRate(playbackRate.playbackRate.value) }}
				<v-tooltip activator="parent" location="top" :disabled="!canHover || menuOpen">
					<span>{{ $t("room.playback-speed") }}</span>
				</v-tooltip>
			</v-btn>
		</template>
		<v-list class="playback-rate-menu" data-player-shortcuts="off">
			<v-list-item
				v-for="(rate, index) in playbackRate.availablePlaybackRates.value"
				:key="index"
				:value="rate"
				:active="rate === playbackRate.playbackRate.value"
				@click="setRate(rate)"
			>
				<v-list-item-title>{{ formatRate(rate) }}</v-list-item-title>
			</v-list-item>
		</v-list>
	</v-menu>
</template>

<script lang="ts" setup>
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { usePlaybackRate } from "../composables";
import { ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { useStore } from "@/store";
import { useGrants } from "../composables/grants";
import { usePlayerControlsActivity } from "@/util/player-controls";

const connection = useConnection();
const roomApi = useRoomApi(connection);
const playbackRate = usePlaybackRate();
const granted = useGrants();
const menuOpen = ref(false);
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
const store = useStore();
usePlayerControlsActivity(menuOpen);
watch(
	() => [store.state.fullscreen, store.state.settings.roomLayout],
	() => {
		menuOpen.value = false;
	},
);

function formatRate(rate: number) {
	return `${rate.toLocaleString(undefined, {
		maximumFractionDigits: 2,
	})}x`;
}

function setRate(rate: number) {
	roomApi.setPlaybackRate(rate);
}

const supported = playbackRate.isPlaybackRateSupported;
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.playback-rate-menu {
	background-color: media-controls.$menu-background !important;
	border-radius: media-controls.$menu-radius !important;
	overscroll-behavior: contain;
}
</style>
