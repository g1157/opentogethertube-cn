<template>
	<iframe
		title="PeerTube Player"
		class="peertube"
		id="peertube-player"
		:src="peertubeUrl"
	></iframe>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, onUnmounted } from "vue";
import { PeerTubePlayer as Peertube } from "@peertube/embed-api";

// CURRENTLY SOMEWHAT BROKEN
// does not respect position syncing for some reason.

// biome-ignore lint/nursery/noVueOptionsApi: TODO: convert to setup
const PeertubePlayer = defineComponent({
	name: "PeertubePlayer",
	props: {
		videoId: { type: String, required: true },
	},
	emits: ["playing", "paused", "ready", "buffering", "error", "apiready"],
	setup(props, { emit }) {
		let player: Peertube | undefined;
		let disposed = false;

		const videoId = computed(() => props.videoId.split(":"));
		const peertubeHost = computed(() => videoId.value[0]);
		const peertubeId = computed(() => videoId.value[1]);
		const peertubeUrl = computed(
			() => `https://${peertubeHost.value}/videos/embed/${peertubeId.value}?controls=0&api=1`,
		);

		onMounted(async () => {
			const container = document.getElementById("peertube-player");
			if (!container) {
				return;
			}

			player = new Peertube(container);
			const instance = player;
			await instance.ready;
			if (disposed) {
				// The surface went away while the embed was still shaking hands; the teardown below
				// already ran, so nothing else will release this instance.
				instance.destroy();
				return;
			}
			instance.addEventListener("playbackStatusChange", onPlaybackStatusChange);
			emit("apiready");
			emit("ready");
		});

		// The SDK keeps the handler in its own event registry, not in the iframe, so removing the
		// iframe does not release it: every mount/unmount of the player would leave another copy of
		// this component's closure alive for as long as the SDK instance is referenced.
		onUnmounted(() => {
			disposed = true;
			if (!player) {
				return;
			}
			player.removeEventListener("playbackStatusChange", onPlaybackStatusChange);
			// The embed API does expose `destroy()`, which removes the iframe element it was given.
			// Ours is already unmounted by now, so this only drops the SDK's own references and the
			// jschannel the player opened for the embed.
			player.destroy();
			player = undefined;
		});

		function onPlaybackStatusChange(status: "playing" | "paused") {
			if (status === "playing") {
				emit("playing");
			} else if (status === "paused") {
				emit("paused");
			}
		}

		async function play(): Promise<void> {
			if (!player) {
				return;
			}
			return await player.play();
		}
		async function pause(): Promise<void> {
			if (!player) {
				return;
			}
			return await player.pause();
		}
		async function getPosition(): Promise<number> {
			if (!player) {
				return 0;
			}
			return player.getCurrentPosition();
		}
		function setPosition(position: number) {
			if (!player) {
				return;
			}
			return player.seek(position);
		}
		function setVolume(value: number) {
			if (!player) {
				return;
			}
			return player.setVolume(value / 100);
		}
		function isCaptionsSupported(): boolean {
			return false;
		}

		function isQualitySupported(): boolean {
			return false;
		}

		function getAvailablePlaybackRates(): number[] {
			return player.getPlaybackRates();
		}

		async function getPlaybackRate(): Promise<number> {
			return await player.getPlaybackRate();
		}

		async function setPlaybackRate(rate: number): Promise<void> {
			await player.setPlaybackRate(rate);
		}

		return {
			supportsRateBend: false,
			peertubeUrl,

			play,
			pause,
			getPosition,
			setPosition,
			setVolume,
			isCaptionsSupported,
			isQualitySupported,
			getAvailablePlaybackRates,
			getPlaybackRate,
			setPlaybackRate,
		};
	},
});

// biome-ignore lint/nursery/noVueOptionsApi: TODO: convert to setup
export default PeertubePlayer;
</script>
