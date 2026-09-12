<template>
	<div v-if="waitingNames" class="buffer-gate-notice" role="status" data-cy="buffer-gate-notice">
		<v-icon :icon="mdiProgressDownload" size="small" />
		<span>{{ $t("room.buffer-gate-waiting", { names: waitingNames }) }}</span>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { mdiProgressDownload } from "@mdi/js";
import { BufferGateMode, PlayerStatus } from "ott-common/models/types";
import { useStore } from "@/store";

const store = useStore();
const waitingNames = computed(() => {
	const room = store.state.room;
	if (
		room.bufferGateMode !== BufferGateMode.Pause ||
		room.isPlaying ||
		!room.currentSource ||
		room.playbackPreparation ||
		room.temporaryPlaybackSpeed
	) {
		return "";
	}
	// Existing room/user sync is sufficient. This describes buffering, not who paused the room.
	let eligibleCount = 0;
	const names: string[] = [];
	for (const viewer of store.state.users.users.values()) {
		if (!room.grants.granted(viewer.role, "playback.play-pause")) {
			continue;
		}
		eligibleCount++;
		if (viewer.status === PlayerStatus.buffering) {
			names.push(viewer.name);
		}
	}
	return eligibleCount >= 2 ? names.join("、") : "";
});
</script>

<style scoped>
.buffer-gate-notice {
	position: absolute;
	top: 3.5rem;
	left: 50%;
	transform: translateX(-50%);
	z-index: 3;
	display: flex;
	align-items: center;
	gap: 0.4rem;
	max-width: calc(100% - 2rem);
	padding: 0.45rem 0.7rem;
	border-radius: 0.5rem;
	background: rgb(0 0 0 / 75%);
	color: white;
	font-size: 0.875rem;
	pointer-events: none;
}
.buffer-gate-notice span {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
