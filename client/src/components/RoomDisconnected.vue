<template>
	<div class="disconnected">
		<h1>{{ $t("connect-overlay.title") }}</h1>
		<span class="dc-reason">{{ reasonText() }}</span>
		<div class="disconnected-actions">
			<v-btn v-if="canReconnect" color="primary" @click="reconnect">{{
				$t("connect-overlay.reconnect")
			}}</v-btn>
			<v-btn to="/rooms">{{ $t("connect-overlay.find-another") }}</v-btn>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useConnection } from "@/plugins/connection";
import { OttWebsocketError } from "ott-common/models/types";

const { t } = useI18n();
const connection = useConnection();
const route = useRoute();

// A generic close is worth another attempt; explicit kicks and missing rooms are not.
const canReconnect = computed(() => connection.kickReason.value === OttWebsocketError.UNKNOWN);

function reconnect() {
	const roomId = route.params.roomId;
	if (typeof roomId === "string" && roomId.length > 0) {
		connection.connect(roomId);
	}
}

function reasonText() {
	if (connection.kickReason.value) {
		const reason = connection.kickReason.value;
		return t(`connect-overlay.dc-reasons.${reason}`);
	} else {
		return t("connect-overlay.dc-reasons.unknown");
	}
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.disconnected {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	height: 100%;
	width: 100%;

	h1 {
		font-size: 2rem;
		margin-bottom: 1rem;
	}

	.dc-reason {
		margin-bottom: 1rem;
		text-align: center;
		max-width: 480px;
	}

	.disconnected-actions {
		display: flex;
		align-items: center;
		gap: 12px;
	}
}
</style>
