<template>
	<div>
		<v-btn
			v-if="!compact"
			variant="text"
			icon
			@click="seekDelta(-seekStep)"
			:disabled="!granted('playback.seek')"
			class="media-control"
			:aria-label="$t('room.rewind', { seconds: seekStep })"
		>
			<v-icon :icon="mdiChevronLeft" />
			<v-tooltip activator="parent" location="bottom">
				<span>{{ $t("room.rewind", { seconds: seekStep }) }}</span>
			</v-tooltip>
		</v-btn>
		<v-btn
			variant="text"
			icon
			@click="togglePlayback()"
			:disabled="!needsLocalPlayback && !granted('playback.play-pause')"
			class="media-control"
			data-cy="playback-toggle"
			:aria-label="needsLocalPlayback ? $t('common.play') : $t('room.play-pause')"
		>
			<v-icon
				:icon="
					store.state.room.isPlaying &&
					store.state.room.currentSource &&
					!needsLocalPlayback
						? mdiPause
						: mdiPlay
				"
			/>
			<v-tooltip activator="parent" location="bottom">
				<span>{{ needsLocalPlayback ? $t("common.play") : $t("room.play-pause") }}</span>
			</v-tooltip>
		</v-btn>
		<v-btn
			variant="text"
			icon
			@click="seekDelta(seekStep)"
			v-if="!compact"
			:disabled="!granted('playback.seek')"
			class="media-control"
			:aria-label="$t('room.skip', { seconds: seekStep })"
		>
			<v-icon :icon="mdiChevronRight" />
			<v-tooltip activator="parent" location="bottom">
				<span>{{ $t("room.skip", { seconds: seekStep }) }}</span>
			</v-tooltip>
		</v-btn>
		<v-btn
			variant="text"
			icon
			@click="skip()"
			v-if="!compact"
			:disabled="!granted('playback.skip')"
			class="media-control"
			:aria-label="
				store.state.room.enableVoteSkip ? $t('room.next-video-vote') : $t('room.next-video')
			"
		>
			<v-icon :icon="mdiSkipForward" />
			<v-tooltip activator="parent" location="bottom">
				<span>
					{{
						store.state.room.enableVoteSkip
							? $t("room.next-video-vote")
							: $t("room.next-video")
					}}
				</span>
			</v-tooltip>
		</v-btn>
	</div>
</template>

<script lang="ts" setup>
import { mdiChevronLeft, mdiPlay, mdiPause, mdiChevronRight, mdiSkipForward } from "@mdi/js";
import _ from "lodash";
import { computed, inject, onMounted, onUnmounted } from "vue";
import { useStore } from "@/store";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { PlayerActionsKey } from "@/util/player-actions";
import { resolveVideoLength } from "@/util/video-length";
import { useGrants } from "../composables/grants";

const props = withDefaults(
	defineProps<{
		currentPosition?: number;
		compact?: boolean;
	}>(),
	{
		currentPosition: 0,
	},
);

const emit = defineEmits(["seek", "play", "pause", "skip"]);

const store = useStore();
const roomapi = useRoomApi(useConnection());
const granted = useGrants();
const actions = inject(PlayerActionsKey, undefined);
const needsLocalPlayback = computed(() => actions?.playbackBlocked.value ?? false);
// The arrow keys, the swipe gesture and these buttons share one step, so the label and
// the actual jump always agree.
const seekStep = computed(() => store.state.settings.seekSeconds);

// Setup Media Session API handlers for the controls in PiP
onMounted(() => {
	if ("mediaSession" in navigator) {
		navigator.mediaSession.setActionHandler("play", () => {
			if (needsLocalPlayback.value || granted("playback.play-pause")) {
				togglePlayback();
			}
		});

		navigator.mediaSession.setActionHandler("pause", () => {
			if (granted("playback.play-pause")) {
				togglePlayback();
			}
		});

		navigator.mediaSession.setActionHandler("nexttrack", () => {
			if (granted("playback.skip")) {
				skip();
			}
		});
	}
});

onUnmounted(() => {
	if ("mediaSession" in navigator) {
		navigator.mediaSession.setActionHandler("play", null);
		navigator.mediaSession.setActionHandler("pause", null);
		navigator.mediaSession.setActionHandler("nexttrack", null);
	}
});

/** Send a message to play or pause the video, depending on the current state. */
function togglePlayback() {
	if (actions) {
		actions.togglePlayback();
		return;
	}
	if (!store.state.room.currentSource) {
		// Nothing to play; an idle room must not gain a phantom isPlaying.
		return;
	}
	if (store.state.room.isPlaying) {
		roomapi.pause();
		emit("pause");
	} else {
		roomapi.play();
		emit("play");
	}
}

function seekDelta(delta: number) {
	const length =
		resolveVideoLength(store.state.room.currentSource?.length, store.state.playerDuration) ?? 0;
	const position = _.clamp(props.currentPosition + delta, 0, length);
	if (actions) {
		actions.seek(position);
	} else {
		roomapi.seek(position);
	}
	emit("seek");
}

function skip() {
	roomapi.skip();
	emit("skip");
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";
</style>
