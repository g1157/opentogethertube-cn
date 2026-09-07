<template>
	<div class="video-controls-wrapper">
		<div
			ref="controlsBar"
			:class="{
				'video-controls': true,
				'in-video': mode === 'in-video',
				'outside-video': mode === 'outside-video',
				'hide': !controlsVisible,
			}"
			:aria-hidden="!controlsVisible"
			:inert="!controlsVisible || undefined"
			@pointerenter="onPointerEnter"
			@pointerleave="onPointerLeave"
			@pointerdown="controls?.hold(dragKey, true)"
			@focusin="onFocusIn"
			@focusout="controls?.hold(focusKey, false)"
		>
			<VideoProgressSlider :current-position="sliderPosition" />
			<div class="controls-row2">
				<BasicControls :current-position="truePosition" />
				<!-- eslint-disable-next-line vue/no-v-model-argument -->
				<VolumeControl />
				<TimestampDisplay :current-position="truePosition" data-cy="timestamp-display" />
				<div class="grow"><!-- Spacer --></div>
				<ClosedCaptionsSwitcher />
				<PlaybackRateSwitcher />
				<VideoSettings @show-shortcuts="emit('show-shortcuts')" />
				<PictureInPictureButton />
				<LayoutSwitcher />
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import BasicControls from "./BasicControls.vue";
import ClosedCaptionsSwitcher from "./ClosedCaptionsSwitcher.vue";
import LayoutSwitcher from "./LayoutSwitcher.vue";
import TimestampDisplay from "./TimestampDisplay.vue";
import VideoProgressSlider from "./VideoProgressSlider.vue";
import VolumeControl from "./VolumeControl.vue";
import PlaybackRateSwitcher from "./PlaybackRateSwitcher.vue";
import VideoSettings from "./VideoSettings.vue";
import PictureInPictureButton from "./PictureInPictureButton.vue";
import { inject, onMounted, onUnmounted, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { PlayerControlsActivityKey } from "@/util/player-controls";

const emit = defineEmits(["show-shortcuts", "resize"]);
const controlsBar = ref<HTMLElement | null>(null);
useResizeObserver(controlsBar, entries => {
	const height = entries[0]?.target.getBoundingClientRect().height;
	if (height) emit("resize", Math.ceil(height));
});
const controls = inject(PlayerControlsActivityKey, undefined);
const hoverKey = Symbol("player:hover");
const dragKey = Symbol("player:drag");
const focusKey = Symbol("player:focus");
function onPointerEnter(event: PointerEvent) {
	if (event.pointerType === "mouse") controls?.hold(hoverKey, true);
}
function onPointerLeave(event: PointerEvent) {
	if (event.pointerType === "mouse") controls?.hold(hoverKey, false);
}
function onFocusIn(event: FocusEvent) {
	if (
		event.target instanceof Element &&
		(event.target.matches(":focus-visible") || event.target.matches('input, [role="slider"]'))
	) {
		controls?.hold(focusKey, true);
	}
	controls?.activity();
}
function releaseDrag() {
	controls?.hold(dragKey, false);
}
onMounted(() => {
	window.addEventListener("pointerup", releaseDrag);
	window.addEventListener("pointercancel", releaseDrag);
	window.addEventListener("blur", releaseDrag);
});
onUnmounted(() => {
	window.removeEventListener("pointerup", releaseDrag);
	window.removeEventListener("pointercancel", releaseDrag);
	window.removeEventListener("blur", releaseDrag);
	for (const key of [hoverKey, dragKey, focusKey]) controls?.hold(key, false);
});

withDefaults(
	defineProps<{
		sliderPosition: number;
		truePosition: number;
		controlsVisible: boolean;
		mode: "in-video" | "outside-video";
	}>(),
	{
		controlsVisible: false,
		mode: "in-video",
	},
);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

$media-control-background: var(--v-theme-media-control-background, (0, 0, 0));

.grow {
	flex-grow: 1;
}

.video-controls {
	position: relative;
	min-height: media-controls.$video-controls-height;
	transition: all 0.2s;
	z-index: 100;
	padding: 12px;
	width: 100%;

	&.hide {
		pointer-events: none;
		visibility: hidden;
	}

	&.in-video {
		position: absolute;
		bottom: 0;

		background: linear-gradient(
			to top,
			rgba($media-control-background, 0.65),
			rgba($media-control-background, 0)
		);
		transition: all 0.2s;

		&.hide {
			opacity: 0;
			transition: all 0.5s;
			bottom: 0;
		}
	}

	&.outside-video {
		background: rgb($media-control-background);
		border-radius: 0 0 10px 10px;

		&.hide {
			opacity: 0;
			transition: all 0.5s;
		}
	}

	.controls-row2 {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		row-gap: 4px;
	}
}
</style>
