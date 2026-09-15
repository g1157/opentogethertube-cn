<template>
	<Teleport :to="teleportTarget" :disabled="teleportTarget === null">
		<transition-group
			appear
			name="toast-list"
			tag="div"
			class="toast-list"
			:class="{ 'toast-list--fullscreen': teleportTarget !== null }"
		>
			<div v-for="(t, index) in visibleToasts" :key="t.id" class="toast-item">
				<ToastNotification :toast="t" :number="index" />
			</div>
			<div v-if="hiddenCount > 0" class="toast-more">
				{{ $t("common.more-notices", { count: hiddenCount }) }}
			</div>
			<v-btn
				block
				color="primary"
				key="closeall"
				@click="closeAll"
				v-if="visibleToasts.length > 1"
				data-cy="toast-close-all"
			>
				{{ $t("common.close-all") }}
			</v-btn>
		</transition-group>
	</Teleport>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import ToastNotification from "@/components/ToastNotification.vue";
import { useStore } from "@/store";
import toast, { FULLSCREEN_TOAST_LEVELS, fullscreenNoticeHost, toastLevel } from "@/util/toast";

/** Two stacked notices are the most a full-screen picture should give up at once. */
const MAX_FULLSCREEN_TOASTS = 2;

const store = useStore();
toast.setStore(store);

const teleportTarget = computed(() => (store.state.fullscreen ? fullscreenNoticeHost.value : null));

const visibleToasts = computed(() => {
	const notifications = store.state.toast.notifications;
	if (teleportTarget.value === null) {
		return notifications;
	}
	// Outside the container the window-mode stack keeps its behavior; inside it only the
	// notices that explain the picture or its playback survive, newest first.
	return notifications
		.filter(notification => FULLSCREEN_TOAST_LEVELS.includes(toastLevel(notification)))
		.slice(-MAX_FULLSCREEN_TOASTS);
});

const hiddenCount = computed(() => {
	const hidden = store.state.toast.notifications.length - visibleToasts.value.length;
	return Math.max(0, hidden);
});

function closeAll() {
	store.commit("toast/CLEAR_ALL_TOASTS");
}
</script>

<style lang="scss" scoped>
.toast-list {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	position: fixed;
	padding: 0;
	bottom: 0;
	right: 0;
	pointer-events: none;
	z-index: 1000;

	.toast,
	button {
		pointer-events: auto;
	}
}

// define the animations for individual toasts
.toast-list-move {
	transition: all 0.25s ease;
}

/* Inside the player container: quiet, small, and clear of the controls. */
.toast-list--fullscreen {
	position: absolute;
	right: 0.75rem;
	bottom: calc(var(--player-controls-height, 90px) + 0.75rem);
	max-width: 320px;
	z-index: 5;
	font-size: 0.8rem;

	.toast-item {
		max-width: 320px;
	}

	:deep(.toast) {
		max-width: 320px;
		padding: 6px 10px;
		background: rgb(0 0 0 / 72%);
		opacity: 0.94;
	}

	.toast-more {
		margin-top: 4px;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgb(0 0 0 / 55%);
		font-size: 0.72rem;
		opacity: 0.85;
	}
}

.toast-list-enter-active,
.toast-list-leave-active {
	transition: all 0.25s;
}
.toast-list-enter,
.toast-list-leave-to {
	opacity: 0;
	transform: translateY(50px);
	// bottom: -50px;
}
</style>
