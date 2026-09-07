<template>
	<v-btn
		variant="text"
		icon
		:disabled="!supported"
		class="media-control"
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
import { computed } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { mdiClosedCaption, mdiClosedCaptionOutline } from "@mdi/js";
import { useCaptions } from "../composables";
import { useStore } from "@/store";

const store = useStore();
const captions = useCaptions();
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");

const supported = computed(() => {
	// For YouTube, always enable caption switch, since its api doesn't return tracklist
	if (store.state.room.currentSource?.service === "youtube") {
		return true;
	}
	return captions.isCaptionsSupported.value && captions.captionsTracks.value.length > 0;
});
const enabled = computed(() => captions.isCaptionsEnabled.value);

function toggleCaptions() {
	captions.isCaptionsEnabled.value = !captions.isCaptionsEnabled.value;
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";
</style>
