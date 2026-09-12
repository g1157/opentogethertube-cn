<script lang="ts" setup>
import { inject, onUnmounted, watch } from "vue";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";
import { PlayerStatus } from "ott-common/models/types";
import { PlayerActionsKey } from "@/util/player-actions";
import _ from "lodash";

const store = useStore();
const connection = useConnection();
const actions = inject(PlayerActionsKey, undefined);
let lastReported: PlayerStatus | undefined;

const playbackStatusUnsub = store.subscribe(mutation => {
	// Subscribers run AFTER Vuex has updated state, so comparing state to the payload drops every update.
	if (mutation.type === "PLAYBACK_STATUS") {
		sendPlaybackStatusDebounced(mutation.payload);
	}
});

function sendPlaybackStatus(status: PlayerStatus) {
	if (!connection.connected.value) {
		return;
	}
	if (status === PlayerStatus.buffering) {
		if (actions?.playbackBlocked.value) {
			status = PlayerStatus.none;
		} else if (document.hidden) {
			// Deliberately treat background stalls as ready: browsers throttle background tabs.
			// Send ready rather than silence so an earlier buffering report is cleared on the server.
			status = PlayerStatus.ready;
		}
	}
	if (status === lastReported) {
		return;
	}
	connection.send({
		action: "status",
		status,
	});
	lastReported = status;
}

const sendPlaybackStatusDebounced = _.debounce(sendPlaybackStatus, 200, { maxWait: 500 });

function reportCurrentStatus() {
	sendPlaybackStatusDebounced.cancel();
	lastReported = undefined;
	sendPlaybackStatus(store.state.playerStatus);
}

document.addEventListener("visibilitychange", reportCurrentStatus);
watch(
	[() => connection.connected.value, () => actions?.playbackBlocked.value],
	reportCurrentStatus,
	{ immediate: true },
);

onUnmounted(() => {
	playbackStatusUnsub();
	sendPlaybackStatusDebounced.cancel();
	document.removeEventListener("visibilitychange", reportCurrentStatus);
});
</script>
