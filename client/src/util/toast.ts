import { ref } from "vue";
import type { Toast, ToastLevel } from "@/models/toast";
import type { Store } from "vuex";
import { useStore } from "@/store";

let _store: Store<unknown> | null = null;

/**
 * The element fullscreen notices are teleported into. A native fullscreen element only
 * renders its own subtree, so the room player lends its container while it is fullscreen.
 */
export const fullscreenNoticeHost = ref<HTMLElement | null>(null);

/** Fullscreen shows only levels that explain the picture or its playback. */
export const FULLSCREEN_TOAST_LEVELS: ToastLevel[] = ["critical", "content"];

export function toastLevel(toast: Toast): ToastLevel {
	return toast.level ?? "social";
}

export function setStore(store: Store<unknown>) {
	_store = store;
}

export function add(toast: Omit<Toast, "id">): void {
	const store = useStore() ?? _store;
	if (!store) {
		throw new Error("toast: Store not found");
	}
	store.commit("toast/ADD_TOAST", toast);
}
export function remove(id: symbol): void {
	const store = useStore() ?? _store;
	if (!store) {
		throw new Error("toast: Store not found");
	}
	store.commit("toast/REMOVE_TOAST", id);
}

export default {
	setStore,
	add,
	remove,
};
