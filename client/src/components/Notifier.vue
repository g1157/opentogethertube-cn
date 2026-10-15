<template>
	<Teleport :to="teleportTarget" :disabled="teleportTarget === null">
		<transition-group
			appear
			name="toast-list"
			tag="div"
			class="toast-list"
			:class="{
				'toast-list--fullscreen': teleportTarget !== null,
				'toast-list--expanded': expanded,
			}"
		>
			<div v-for="(t, index) in visibleToasts" :key="t.id" class="toast-item">
				<ToastNotification :toast="t" :number="index" :persistent="expanded" />
			</div>
			<button
				v-if="!expanded && hiddenCount > 0"
				type="button"
				class="toast-more"
				data-cy="toast-more-toggle"
				:aria-label="$t('common.show-notices', { count: hiddenCount })"
				@click="expanded = true"
			>
				{{ $t("common.more-notices", { count: hiddenCount }) }}
				<v-icon :icon="mdiChevronUp" :size="14" aria-hidden="true" />
			</button>
			<button
				v-else-if="expanded"
				type="button"
				class="toast-more toast-collapse"
				data-cy="toast-collapse"
				:aria-label="$t('common.collapse-notices')"
				@click="expanded = false"
			>
				{{ $t("common.collapse-notices") }}
				<v-icon :icon="mdiChevronDown" :size="14" aria-hidden="true" />
			</button>
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
import { computed, ref, watch } from "vue";
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
import ToastNotification from "@/components/ToastNotification.vue";
import { useStore } from "@/store";
import toast, { FULLSCREEN_TOAST_LEVELS, fullscreenNoticeHost, toastLevel } from "@/util/toast";

/** Two stacked notices are the most a full-screen picture should give up at once. */
const MAX_FULLSCREEN_TOASTS = 2;
/** A burst of room events must not grow the corner stack until it covers the page. */
const MAX_WINDOW_TOASTS = 4;

const store = useStore();
toast.setStore(store);

const teleportTarget = computed(() => (store.state.fullscreen ? fullscreenNoticeHost.value : null));

/** The review view: every pending notice, held open until each one is closed. */
const expanded = ref(false);

const visibleToasts = computed(() => {
	const notifications = store.state.toast.notifications;
	if (expanded.value) {
		// The review view is explicit user intent: it shows everything, including the
		// social notices fullscreen would otherwise filter out.
		return notifications;
	}
	if (teleportTarget.value === null) {
		// Newest first; older cards collapse into the counter instead of stacking upward.
		return notifications.slice(-MAX_WINDOW_TOASTS);
	}
	// Inside the player container only the notices that explain the picture or its playback
	// survive, newest first.
	return notifications
		.filter(notification => FULLSCREEN_TOAST_LEVELS.includes(toastLevel(notification)))
		.slice(-MAX_FULLSCREEN_TOASTS);
});

const hiddenCount = computed(() => {
	if (expanded.value) {
		return 0;
	}
	const hidden = store.state.toast.notifications.length - visibleToasts.value.length;
	return Math.max(0, hidden);
});

// Leaving the place the list was opened from, or emptying the list, ends the review view.
watch(teleportTarget, () => {
	expanded.value = false;
});
watch(
	() => store.state.toast.notifications.length,
	length => {
		if (length === 0) {
			expanded.value = false;
		}
	},
);

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

	.toast-more {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 4px;
		padding: 3px 10px;
		border: 0;
		border-radius: 999px;
		background: rgb(0 0 0 / 55%);
		color: white;
		font: inherit;
		font-size: 0.72rem;
		min-height: 24px;
		opacity: 0.9;
		cursor: pointer;
	}

	.toast-more:hover,
	.toast-more:focus-visible {
		background: rgb(0 0 0 / 72%);
		opacity: 1;
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
		// The base card asks for 344px minimum, which is wider than this cap — on a phone
		// in fullscreen the two fought and the minimum won.
		min-width: 0;
		min-height: 0;
		padding: 6px 10px;
		font-size: 0.82rem;
		background: rgb(0 0 0 / 72%);
		opacity: 0.94;
	}

	:deep(.toast .toast-content) {
		padding: 2px 6px;
		line-height: 1.3;
	}

	:deep(.toast .bar) {
		height: 2px;
	}
}

/* The review view: a bounded, scrollable list instead of an ever-growing stack. */
.toast-list--expanded {
	// An open panel takes pointer input instead of passing taps to the player beneath.
	pointer-events: auto;
	overflow-y: auto;
	overscroll-behavior: contain;
	touch-action: pan-y;
}

.toast-list--expanded.toast-list--fullscreen {
	max-height: min(60vh, calc(100% - var(--player-controls-height, 90px) - 3.5rem));
}

.toast-list--expanded:not(.toast-list--fullscreen) {
	max-height: min(70vh, calc(100vh - 4rem));
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

// Phones: this is a full-width material button by default, which costs a whole toast's
// height for one tap. Keep it a small chip at the right edge. The coarse-pointer clause
// covers landscape, where the viewport is wider than the phone breakpoint.
@media (max-width: 800px), (pointer: coarse) {
	.toast-list button.v-btn {
		width: auto;
		// The block variant pins both of these to the full stack width; a chip avoids it.
		min-width: 0;
		flex: 0 0 auto;
		height: 30px;
		min-height: 30px;
		margin: 2px 6px 4px 0;
		padding: 0 12px;
		font-size: 0.75rem;
	}
}
</style>
