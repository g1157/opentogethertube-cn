<template>
	<v-dialog
		:model-value="modelValue"
		max-width="420"
		@update:model-value="$emit('update:modelValue', $event)"
	>
		<v-card>
			<v-card-title>{{ $t("room-password.enter-title") }}</v-card-title>
			<v-card-text>
				<p class="text-body-2 mb-3">{{ $t("room-password.enter-hint") }}</p>
				<v-text-field
					v-model="password"
					type="password"
					:label="$t('room-password.field-label')"
					autocomplete="current-password"
					:error-messages="error"
					@keydown.enter="submit"
					data-cy="input-join-room-password"
				/>
			</v-card-text>
			<v-card-actions>
				<v-spacer />
				<v-btn
					variant="text"
					@click="$emit('update:modelValue', false)"
					data-cy="btn-cancel-join-room-password"
				>
					{{ $t("common.cancel") }}
				</v-btn>
				<v-btn
					variant="text"
					color="primary"
					:loading="submitting"
					:disabled="password.length < 1"
					@click="submit"
					data-cy="btn-submit-join-room-password"
				>
					{{ $t("room-password.enter-action") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import { API } from "@/common-http";
import { useI18n } from "vue-i18n";
import { serverErrorMessage } from "@/util/server-error";

const props = defineProps<{ modelValue: boolean; roomName: string }>();
const emit = defineEmits(["update:modelValue", "verified"]);

const { t } = useI18n();
const password = ref("");
const error = ref("");
const submitting = ref(false);

async function submit() {
	if (submitting.value || password.value.length === 0) {
		return;
	}
	submitting.value = true;
	error.value = "";
	try {
		await API.post(`/room/${props.roomName}/password`, { password: password.value });
		password.value = "";
		emit("verified");
	} catch (err) {
		const apiError = err?.response?.data?.error;
		error.value = apiError ? serverErrorMessage(apiError) : t("errors.network").toString();
	} finally {
		submitting.value = false;
	}
}
</script>
