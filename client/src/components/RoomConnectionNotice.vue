<template>
	<v-alert
		v-if="visible"
		type="warning"
		variant="tonal"
		class="mb-3"
		data-cy="connection-notice"
		role="status"
	>
		<div>
			{{
				$t(
					connection.issue.value === "timeout"
						? "room.con-status.timeout"
						: "room.con-status.reconnecting",
				)
			}}
		</div>
		<div class="text-body-2 mt-1">{{ $t("room.con-status.network-help") }}</div>
		<v-btn class="mt-2" variant="outlined" size="small" @click="connection.reconnect()">
			{{ $t("room.con-status.retry") }}
		</v-btn>
	</v-alert>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useConnection } from "@/plugins/connection";

/**
 * A dropped socket normally comes back within a second or two — a background tab, a laptop
 * waking up, a network switch — and a notice for that is pure noise. Only an interruption
 * that survives the automatic retries is worth an alert with the troubleshooting help.
 */
const GRACE_MS = 10_000;

const connection = useConnection();

const interrupted = computed(
	() => !!connection.issue.value && connection.active.value && !connection.connected.value,
);
const graceElapsed = ref(false);
let graceTimer: ReturnType<typeof setTimeout> | null = null;

function clearGraceTimer() {
	if (graceTimer !== null) {
		clearTimeout(graceTimer);
		graceTimer = null;
	}
}

watch(
	interrupted,
	value => {
		clearGraceTimer();
		graceElapsed.value = false;
		if (!value) {
			return;
		}
		graceTimer = setTimeout(() => {
			graceTimer = null;
			graceElapsed.value = true;
		}, GRACE_MS);
	},
	{ immediate: true },
);

onUnmounted(clearGraceTimer);

const visible = computed(() => interrupted.value && graceElapsed.value);
</script>
