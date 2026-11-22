<template>
	<v-btn
		variant="text"
		icon
		v-if="isBrowserSupported"
		:disabled="!currentVideo"
		class="media-control"
		:aria-label="$t('room.pip')"
		@click="toggle()"
	>
		<v-icon
			:icon="
				isActive ? mdiPictureInPictureBottomRight : mdiPictureInPictureBottomRightOutline
			"
		/>
		<v-tooltip activator="parent" location="bottom">
			{{ $t("room.pip") }}
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from "vue";
import { mdiPictureInPictureBottomRight, mdiPictureInPictureBottomRightOutline } from "@mdi/js";
import { i18n } from "@/i18n";
import { ToastStyle } from "@/models/toast";
import { useMediaPlayer } from "@/components/composables";
import {
	isPictureInPictureSupported,
	togglePictureInPicture,
	type PictureInPictureFailure,
} from "@/util/picture-in-picture";
import toast from "@/util/toast";

const controls = useMediaPlayer();
const isActive = ref(false);
const currentVideo = ref<HTMLVideoElement | null>(null);
let observer: MutationObserver | null = null;

/**
 * Firefox only shipped this API in 153, and both Chrome and Firefox can switch it off — a page
 * that merely checks that the property exists shows a button that always fails.
 */
const isBrowserSupported = isPictureInPictureSupported();

/**
 * The player's own element first: the room rebuilds it on a CORS fallback, and a queue preview
 * can put another `<video>` in the document before this one.
 */
function resolveVideo(): HTMLVideoElement | null {
	const owned = controls.player.value?.getVideoElement?.();
	if (owned) {
		return owned;
	}
	return document.querySelector("video");
}

function syncActive() {
	isActive.value =
		!!currentVideo.value && document.pictureInPictureElement === currentVideo.value;
}

function attachVideo(video: HTMLVideoElement | null) {
	if (currentVideo.value) {
		currentVideo.value.removeEventListener("enterpictureinpicture", syncActive);
		currentVideo.value.removeEventListener("leavepictureinpicture", syncActive);
		currentVideo.value.removeEventListener("loadedmetadata", syncActive);
	}
	if (video) {
		video.addEventListener("enterpictureinpicture", syncActive);
		video.addEventListener("leavepictureinpicture", syncActive);
		// Firefox sets `pictureInPictureElement` without guaranteeing the order of its events;
		// reading the state back on the element's own lifecycle keeps the icon honest.
		video.addEventListener("loadedmetadata", syncActive);
	}
	currentVideo.value = video;
	syncActive();
}

function observeVideo() {
	const video = resolveVideo();
	if (video !== currentVideo.value) {
		attachVideo(video);
	}
}

onMounted(() => {
	observeVideo();
	// A source switch replaces the element; a CORS fallback rebuilds it.
	observer = new MutationObserver(() => observeVideo());
	observer.observe(document.body, { childList: true, subtree: true });
});

onUnmounted(() => {
	attachVideo(null);
	observer?.disconnect();
});

function failureMessage(failure: PictureInPictureFailure): string {
	return i18n.global.t(
		failure === "unsupported" || failure === "disabled"
			? "room.pip-unavailable"
			: "room.pip-failed",
	);
}

async function toggle() {
	const video = resolveVideo();
	if (video !== currentVideo.value) {
		attachVideo(video);
	}
	const outcome = await togglePictureInPicture(video);
	syncActive();
	if (outcome === "entered" || outcome === "left") {
		return;
	}
	// The old handler only logged this, so a refused request looked like a broken button —
	// which is exactly what Firefox's pref and its metadata rule look like from the outside.
	toast.add({
		style: ToastStyle.Error,
		content: failureMessage(outcome),
		duration: 6000,
	});
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";
</style>
