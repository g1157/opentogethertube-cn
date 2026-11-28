import { computed, onUnmounted, provide, useTemplateRef, watch } from "vue";
import { useStore } from "@/store";
import { createPlayerFullscreen, PlayerFullscreenKey } from "@/util/player-fullscreen";
import { fullscreenNoticeHost } from "@/util/toast";

/**
 * Fullscreen for the room player. The player container is the fullscreen element, so the
 * controls, the brightness scrim and the notices have to live inside it.
 *
 * The injected fullscreen handle and the native/fallback split are covered by
 * `util/player-fullscreen`; this only binds it to the room's template ref and to the
 * store's `fullscreen` flag.
 */
export function useRoomFullscreen() {
	const store = useStore();
	const fullscreenContainer = useTemplateRef<HTMLDivElement>("fullscreenContainer");
	const fullscreen = createPlayerFullscreen(
		() => fullscreenContainer.value,
		active => store.commit("SET_FULLSCREEN", active),
	);
	provide(PlayerFullscreenKey, fullscreen);
	onUnmounted(() => fullscreen.dispose());
	const fullscreenOverlayDefaults = computed(() => {
		const attach = store.state.fullscreen ? fullscreenContainer.value : false;
		return { VMenu: { attach }, VTooltip: { attach }, VDialog: { attach } };
	});

	// A native fullscreen element only renders its own subtree: notices and the
	// connection bar have to live inside the player while it is fullscreen, or they are
	// silently lost (toasts already teleport there through this ref).
	function syncFullscreenNoticeHost() {
		fullscreenNoticeHost.value =
			store.state.fullscreen && fullscreenContainer.value ? fullscreenContainer.value : null;
	}
	watch([() => store.state.fullscreen, fullscreenContainer], syncFullscreenNoticeHost, {
		flush: "post",
	});

	return {
		fullscreenContainer,
		fullscreen,
		fullscreenOverlayDefaults,
		/** Must run once on mount so an already-fullscreen player gets the notice host. */
		syncFullscreenNoticeHost,
	};
}
