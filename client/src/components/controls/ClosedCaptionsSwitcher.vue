<template>
	<v-menu
		v-if="hasTracklist"
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
		content-class="subtitle-menu-overlay"
	>
		<template #activator="{ props }">
			<v-btn
				v-bind="props"
				variant="text"
				icon
				:disabled="!supported"
				class="media-control"
				data-cy="subtitle-toggle"
				:aria-label="$t('room.subtitles')"
			>
				<v-icon :icon="enabled ? mdiClosedCaption : mdiClosedCaptionOutline" />
				<v-tooltip activator="parent" location="top" :disabled="!canHover">
					{{ $t("room.subtitles") }}
				</v-tooltip>
			</v-btn>
		</template>

		<v-list v-if="isMenuOpen" class="menu-content subtitle-menu-list" density="compact">
			<SubtitleMenuPanel @select="isMenuOpen = false" />
		</v-list>
	</v-menu>
	<!-- An embedded player that exposes no tracklist (YouTube) can still toggle captions
	     on and off, it just cannot name the tracks. -->
	<v-btn
		v-else
		variant="text"
		icon
		:disabled="!supported"
		class="media-control"
		data-cy="subtitle-toggle"
		:aria-label="$t('room.subtitles')"
		@click="toggleCaptions()"
	>
		<v-icon :icon="enabled ? mdiClosedCaption : mdiClosedCaptionOutline" />
		<v-tooltip activator="parent" location="top" :disabled="!canHover">
			{{ $t("room.subtitles") }}
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { mdiClosedCaption, mdiClosedCaptionOutline } from "@mdi/js";
import { useCaptions } from "../composables";
import { useStore } from "@/store";
import { usePlayerControlsActivity } from "@/util/player-controls";
import SubtitleMenuPanel from "./SubtitleMenuPanel.vue";

const store = useStore();
const captions = useCaptions();
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
const isMenuOpen = ref(false);
// The menu counts as player activity, so the control bar does not hide out from under it.
usePlayerControlsActivity(isMenuOpen);

const supported = computed(() => {
	// For YouTube, always enable caption switch, since its api doesn't return tracklist
	if (store.state.room.currentSource?.service === "youtube") {
		return true;
	}
	return captions.isCaptionsSupported.value && captions.captionsTracks.value.length > 0;
});
const hasTracklist = computed(
	() => captions.isCaptionsSupported.value && captions.captionsTracks.value.length > 0,
);
const enabled = computed(() => captions.isCaptionsEnabled.value);

function toggleCaptions() {
	captions.isCaptionsEnabled.value = !captions.isCaptionsEnabled.value;
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.subtitle-menu-list {
	background: media-controls.$menu-background;
	border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
	border-radius: media-controls.$menu-radius;
	padding: 4px 0;
}
</style>
