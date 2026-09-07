import { computed, inject, onUnmounted, ref, watch, type InjectionKey, type Ref } from "vue";

interface PlayerControlsActivity {
	activity(): void;
	hold(key: symbol, active: boolean): void;
}

export const PlayerControlsActivityKey: InjectionKey<PlayerControlsActivity> = Symbol(
	"player:controls-activity",
);

/** Menus retain visible controls until they close, including teleported Vuetify menus. */
export function usePlayerControlsActivity(open: Ref<boolean>) {
	const controls = inject(PlayerControlsActivityKey, undefined);
	const key = Symbol("player:menu");
	watch(open, value => controls?.hold(key, value), { immediate: true, flush: "sync" });
	onUnmounted(() => controls?.hold(key, false));
}

export function usePlayerControls(shouldStayVisible: () => boolean) {
	const visible = ref(true);
	const timeout = ref<ReturnType<typeof setTimeout> | null>(null);
	const holds = ref(new Set<symbol>());
	const pinned = computed(() => shouldStayVisible() || holds.value.size > 0);
	let lastMouse: { x: number; y: number } | null = null;
	let hiddenAt: { x: number; y: number } | null = null;
	let manuallyHidden = false;
	let disposed = false;

	function clearTimer() {
		if (timeout.value !== null) {
			clearTimeout(timeout.value);
			timeout.value = null;
		}
	}

	function scheduleHide() {
		clearTimer();
		if (!disposed && visible.value && !pinned.value) {
			timeout.value = setTimeout(() => {
				timeout.value = null;
				if (!pinned.value) {
					visible.value = false;
				}
			}, 3000);
		}
	}

	function activity() {
		if (disposed) {
			return;
		}
		visible.value = true;
		manuallyHidden = false;
		hiddenAt = null;
		scheduleHide();
	}

	function hide() {
		clearTimer();
		if (!pinned.value) {
			visible.value = false;
			manuallyHidden = true;
			hiddenAt = lastMouse;
		}
	}

	function hold(key: symbol, active: boolean) {
		if (active) {
			holds.value.add(key);
			activity();
		} else {
			holds.value.delete(key);
			scheduleHide();
		}
	}

	function mouseMove(event: PointerEvent) {
		if (event.pointerType !== "mouse" || event.buttons !== 0) {
			return;
		}
		lastMouse = { x: event.clientX, y: event.clientY };
		if (manuallyHidden) {
			hiddenAt ??= lastMouse;
			if (Math.hypot(lastMouse.x - hiddenAt.x, lastMouse.y - hiddenAt.y) < 10) {
				return;
			}
		}
		activity();
	}

	watch(pinned, value => (value ? activity() : scheduleHide()), { immediate: true });
	onUnmounted(() => {
		disposed = true;
		clearTimer();
	});

	return { visible, timeout, activity, hide, hold, mouseMove };
}
