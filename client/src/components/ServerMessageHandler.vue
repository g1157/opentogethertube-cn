<template>
	<span></span>
</template>

<script lang="ts" setup>
import { onUnmounted } from "vue";
import type { ServerMessage } from "ott-common/models/messages";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";

const store = useStore();
const connection = useConnection();

const handlers = (
	[
		["sync", "room/sync"],
		["chat", "chat"],
		["announcement", "announcement"],
		["user", "users/user"],
		["you", "users/you"],
		["event", "event"],
		["eventcustom", "eventcustom"],
	] as const
).map(([action, storeAction]) => {
	const handler = (message: ServerMessage) => {
		void store.dispatch(storeAction, message);
	};
	connection.addMessageHandler(action, handler);
	return { action, handler };
});

onUnmounted(() => {
	// A replacement can register its handlers before this instance's unmount hook runs.
	for (const { action, handler } of handlers) {
		connection.removeMessageHandler(action, handler);
	}
});
</script>
