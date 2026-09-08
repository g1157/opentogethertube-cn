<template>
	<v-alert
		v-if="connection.issue.value && connection.active.value && !connection.connected.value"
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
import { useConnection } from "@/plugins/connection";

const connection = useConnection();
</script>
