<template>
	<div ref="rootElem" class="player">
		<iframe
			:key="iframeKey"
			:src="iframeSrc"
			scrolling="no"
			border="0"
			frameborder="no"
			framespacing="0"
			allowfullscreen="true"
			referrerpolicy="no-referrer"
			class="bilibili-iframe"
		></iframe>
	</div>
</template>

<script lang="ts" setup>
// Bilibili's embed player offers no JavaScript API: the iframe cannot be played,
// paused, seeked or read programmatically. Sync here is therefore "coarse": room
// events load (and reload with a start time) the right video/part for everyone, but
// in-frame playback stays in the viewer's hands. This is a documented downgrade for
// this service, not a bug.
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{
	videoId: string;
}>();

const emit = defineEmits<{
	"apiready": [];
	"buffering": [];
	"playing": [];
	"paused": [];
}>();

const rootElem = ref<HTMLElement>();
const iframeKey = ref(0);
const basePosition = ref(0);
const loadStartedAt = ref(Date.now());
/** Set when the room plays; the embed only autoplays via its URL parameter. */
const autoplay = ref(false);

function parseId(id: string): { bvid: string; page: number } {
	const [raw, partSuffix] = id.split("@p");
	const page = Number(partSuffix ?? "1") || 1;
	return { bvid: raw, page };
}

const iframeSrc = computed(() => {
	const { bvid, page } = parseId(props.videoId);
	const params = new URLSearchParams({
		bvid,
		page: String(page),
		autoplay: autoplay.value ? "1" : "0",
		danmaku: "0",
	});
	// The embed's parameter name is snake_case on the wire.
	params.set("high_quality", "1");
	if (basePosition.value > 1) {
		// The embed honors a start time in seconds on current builds; when it does
		// not, playback just starts from zero, which is an accepted degradation.
		params.set("t", String(Math.round(basePosition.value)));
	}
	return `https://player.bilibili.com/player.html?${params.toString()}`;
});

function reloadAt(position: number): void {
	basePosition.value = position;
	loadStartedAt.value = Date.now();
	iframeKey.value++;
	emit("buffering");
}

// A new video id re-points the iframe via the computed src; reset the local clock.
watch(
	() => props.videoId,
	() => {
		basePosition.value = 0;
		loadStartedAt.value = Date.now();
	},
);

onMounted(() => {
	emit("apiready");
});

function play(): void {
	// Reload with autoplay: this is the closest an embed without a JS API gets to
	// honoring a room-wide play. Browsers may still block it until a user gesture.
	autoplay.value = true;
	reloadAt(getPosition());
	emit("playing");
}

function pause(): void {
	// Cannot pause the iframe from outside; the room state still updates for others.
	autoplay.value = false;
	emit("paused");
}

function getPosition(): number {
	// Best-effort estimate assuming playback started at the last (re)load.
	const elapsed = (Date.now() - loadStartedAt.value) / 1000;
	return basePosition.value + elapsed;
}

function setPosition(position: number): void {
	reloadAt(position);
}

function setVolume(): void {
	// The embed has its own volume control.
}

function isCaptionsSupported(): boolean {
	return false;
}

function isQualitySupported(): boolean {
	return false;
}

function getAvailablePlaybackRates(): number[] {
	return [1];
}

defineExpose({
	supportsRateBend: false,
	play,
	pause,
	getPosition,
	setPosition,
	setVolume,
	isCaptionsSupported,
	isQualitySupported,
	getAvailablePlaybackRates,
});
</script>

<style scoped>
.player,
.bilibili-iframe {
	width: 100%;
	height: 100%;
	border: none;
}
</style>
