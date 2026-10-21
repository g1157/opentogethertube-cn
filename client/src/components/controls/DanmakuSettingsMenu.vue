<template>
	<v-menu
		v-model="isMenuOpen"
		location="top end"
		origin="auto"
		:offset="8"
		:width="280"
		:min-width="0"
		:max-width="280"
		:max-height="360"
		:close-on-content-click="false"
		scroll-strategy="reposition"
		content-class="danmaku-settings-overlay"
	>
		<template #activator="{ props }">
			<v-btn
				v-bind="props"
				variant="text"
				icon
				class="media-control"
				data-cy="danmaku-settings-toggle"
				:aria-label="$t('room.danmaku.settings')"
			>
				<v-icon :icon="mdiTuneVariant" />
				<v-tooltip activator="parent" location="top" :disabled="!canHover">
					{{ $t("room.danmaku.settings") }}
				</v-tooltip>
			</v-btn>
		</template>

		<v-container v-if="isMenuOpen" class="danmaku-settings-menu" data-player-shortcuts="off">
			<v-list class="menu-content danmaku-panel-list" density="compact">
				<DanmakuSettingsPanel />
			</v-list>
		</v-container>
	</v-menu>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { mdiTuneVariant } from "@mdi/js";
import { usePlayerControlsActivity } from "@/util/player-controls";
import DanmakuSettingsPanel from "./DanmakuSettingsPanel.vue";

const isMenuOpen = ref(false);
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
// The menu counts as player activity, so the control bar does not hide out from under it.
usePlayerControlsActivity(isMenuOpen);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.danmaku-settings-menu {
	/* The panel is taller than the menu allows, so it scrolls. The layered background
	   draws a soft shadow at the edges that still have content, so the reader knows
	   there is more below instead of assuming the panel ends here. */
	background: linear-gradient(media-controls.$menu-background 30%, transparent) top / 100% 20px
			no-repeat local,
		linear-gradient(transparent, media-controls.$menu-background 70%) bottom / 100% 20px
			no-repeat local,
		radial-gradient(farthest-side at 50% 0, rgb(0 0 0 / 35%), transparent) top / 100% 10px
			no-repeat scroll,
		radial-gradient(farthest-side at 50% 100%, rgb(0 0 0 / 35%), transparent) bottom / 100% 10px
			no-repeat scroll,
		media-controls.$menu-background;
	border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
	border-radius: media-controls.$menu-radius;
	padding: 0;
	width: 100%;
	min-height: 0;
	max-height: inherit;
	box-shadow: 0 4px 20px rgba(var(--v-theme-surface), 0.3);
	overflow-y: auto;
	overscroll-behavior: contain;
}
</style>
