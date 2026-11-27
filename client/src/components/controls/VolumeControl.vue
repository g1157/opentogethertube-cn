<template>
	<v-btn
		icon
		variant="text"
		size="small"
		class="media-control"
		:aria-label="muteLabel"
		@click="toggleMute"
		data-cy="volume-toggle"
	>
		<v-icon :icon="volumeIcon" />
		<v-tooltip activator="parent" location="bottom" :disabled="!canHover">
			<span>{{ muteLabel }}</span>
		</v-tooltip>
	</v-btn>
	<div class="volume">
		<vue-slider
			ref="slider"
			:model-value="volume.volume.value"
			@update:model-value="changed"
			:tooltip-placement="'bottom'"
			:tooltip="'hover'"
			:tooltip-formatter="value => `${value}%`"
			:tooltip-style="{
				backgroundColor: 'rgb(var(--v-theme-surface-variant))',
				color: 'rgb(var(--v-theme-on-surface-variant))',
			}"
			:process="
				dotsPos => [
					[
						0,
						dotsPos[0],
						{
							backgroundColor: 'rgb(var(--v-theme-primary))',
						},
					],
				]
			"
			:drag-on-click="true"
			data-cy="volume-slider"
		/>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { useMediaQuery } from "@vueuse/core";
import VueSlider from "vue-slider-component";
import "vue-slider-component/theme/default.css";
import { useI18n } from "vue-i18n";
import { useVolume } from "../composables";
import { useSliderHandleAttrs } from "./slider-a11y";
import { mdiVolumeHigh, mdiVolumeMedium, mdiVolumeLow, mdiVolumeOff } from "@mdi/js";

const emit = defineEmits(["update:volume"]);

const { t } = useI18n();
const volume = useVolume();
const slider = ref<{ $el?: HTMLElement } | null>(null);
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");

/** The button announces what it will do, so mute and unmute must not share a name. */
const muteLabel = computed(() =>
	volume.isMuted.value ? t("player.volume-unmute") : t("player.volume-mute"),
);

// The slider's handle carries its own `role="slider"`; name it and give it the value in
// words, the same way the progress bar labels its handle.
useSliderHandleAttrs(slider, () => ({
	"aria-label": t("player.volume"),
	"aria-valuetext": `${Math.round(volume.volume.value)}%`,
}));

const volumeIcon = computed(() => {
	const volumeLevel = volume.volume.value;
	if (volume.isMuted.value || volumeLevel === 0) {
		return mdiVolumeOff;
	}

	if (volumeLevel >= 66) {
		return mdiVolumeHigh;
	} else if (volumeLevel >= 33) {
		return mdiVolumeMedium;
	} else {
		return mdiVolumeLow;
	}
});

function changed(value: number) {
	emit("update:volume", value);
	volume.volume.value = value;
}

function toggleMute() {
	volume.isMuted.value = !volume.isMuted.value;
}
</script>

<style lang="scss" scoped>
@use "./media-controls.scss";
@use "../../variables.scss";

.volume {
	width: 150px;
	margin-left: 10px;
	margin-right: 20px;

	@media (max-width: variables.$md-max) {
		width: 100px;
	}
}
</style>
