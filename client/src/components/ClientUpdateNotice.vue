<template>
	<div v-if="visible" class="client-update-notice" role="status">
		<span>{{ $t("client-update.text") }}</span>
		<v-btn
			size="small"
			color="primary"
			variant="text"
			data-cy="client-update-refresh"
			@click="refresh"
		>
			{{ $t("client-update.action") }}
		</v-btn>
		<v-btn
			icon
			size="x-small"
			variant="text"
			:aria-label="$t('client-update.dismiss')"
			@click="dismiss"
		>
			<v-icon :icon="mdiClose" />
		</v-btn>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { mdiClose } from "@mdi/js";
import { applyClientUpdate, clientUpdateReady, dismissClientUpdate } from "@/util/client-update";

const hidden = ref(false);
const visible = computed(() => clientUpdateReady.value && !hidden.value);

function refresh() {
	applyClientUpdate();
}

function dismiss() {
	hidden.value = true;
	dismissClientUpdate();
}
</script>

<style lang="scss" scoped>
.client-update-notice {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 6px 16px;
	font-size: 0.875rem;
	color: var(--foreground);
	background: var(--surface);
	border-bottom: 1px solid var(--line-strong);
}
</style>
