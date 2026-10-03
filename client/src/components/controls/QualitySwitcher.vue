<template>
	<v-menu
		v-if="supported"
		v-model="isMenuOpen"
		location="top end"
		origin="auto"
		:offset="8"
		:width="260"
		:min-width="0"
		:max-width="260"
		:max-height="420"
		:close-on-content-click="true"
		scroll-strategy="reposition"
		content-class="quality-menu-overlay"
	>
		<template #activator="{ props }">
			<v-btn
				v-bind="props"
				variant="text"
				class="media-control quality-switcher"
				data-cy="quality-toggle"
				:aria-label="$t('room.quality')"
			>
				{{ display }}
			</v-btn>
		</template>

		<v-list v-if="isMenuOpen" class="menu-content quality-menu-list" density="compact">
			<QualityMenuPanel @select="isMenuOpen = false" />
		</v-list>
	</v-menu>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQualities } from "../composables";
import { usePlayerControlsActivity } from "@/util/player-controls";
import QualityMenuPanel from "./QualityMenuPanel.vue";

const { t } = useI18n();
const qualities = useQualities();
const isMenuOpen = ref(false);
// The menu counts as player activity, so the control bar does not hide out from under it.
usePlayerControlsActivity(isMenuOpen);

const supported = computed(
	() => qualities.isQualitySupported.value && qualities.videoTracks.value.length > 0,
);

const display = computed(() => {
	const currentTrack = qualities.currentVideoTrack.value;
	if (qualities.isAutoQualitySupported.value && currentTrack === -1) {
		return t("player.settings.auto");
	}
	const currentQuality = qualities.videoTracks.value[currentTrack];
	const resolution = currentQuality && (currentQuality.height || currentQuality.width);
	return resolution ? `${resolution}p` : t("player.settings.auto");
});
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.quality-switcher {
	min-width: 0;
	padding: 0 8px;
	text-transform: none;
	font-size: 0.85rem;
	font-weight: 500;
}

.quality-menu-list {
	background: media-controls.$menu-background;
	border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
	border-radius: media-controls.$menu-radius;
	padding: 4px 0;
}
</style>
