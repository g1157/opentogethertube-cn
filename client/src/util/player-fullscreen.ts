import type { InjectionKey } from "vue";

export interface PlayerFullscreen {
	/** Resolves true when native fullscreen is active (or was already); false when only the
	 * in-page fallback applies. */
	enter(): Promise<boolean>;
	exit(): Promise<void>;
	toggle(): Promise<void>;
	dispose(): void;
}

export const PlayerFullscreenKey: InjectionKey<PlayerFullscreen> = Symbol("player:fullscreen");

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & {
	webkitFullscreenElement?: Element;
	webkitExitFullscreen?: () => Promise<void> | void;
};

/** Keep native and fallback fullscreen scoped to the player, including its controls. */
export function createPlayerFullscreen(
	getTarget: () => HTMLElement | null,
	onChange: (active: boolean) => void,
): PlayerFullscreen {
	const doc = document as FullscreenDocument;
	let activeTarget: HTMLElement | null = null;
	let fallback = false;
	let requesting = false;
	let disposed = false;
	let generation = 0;
	let restoreScroll: (() => void) | undefined;

	function nativeElement() {
		return doc.fullscreenElement ?? doc.webkitFullscreenElement;
	}

	function setActive(target: HTMLElement | null) {
		if (activeTarget === target) {
			return;
		}
		activeTarget?.classList.remove("player-fullscreen");
		if (!activeTarget && target) {
			const x = window.scrollX;
			const y = window.scrollY;
			const styles: [HTMLElement, string, string, string][] = [];
			const setStyle = (element: HTMLElement, property: string, value: string) => {
				styles.push([
					element,
					property,
					element.style.getPropertyValue(property),
					element.style.getPropertyPriority(property),
				]);
				element.style.setProperty(property, value);
			};
			setStyle(doc.documentElement, "overflow", "hidden");
			setStyle(doc.documentElement, "overscroll-behavior", "none");
			setStyle(doc.body, "overflow", "hidden");
			// A fixed body also stops background touch scrolling in mobile Safari.
			setStyle(doc.body, "position", "fixed");
			setStyle(doc.body, "top", `${-y}px`);
			setStyle(doc.body, "left", `${-x}px`);
			setStyle(doc.body, "width", "100%");
			restoreScroll = () => {
				for (const [element, property, value, priority] of styles) {
					if (value) {
						element.style.setProperty(property, value, priority);
					} else {
						element.style.removeProperty(property);
					}
				}
				window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior });
			};
		}
		activeTarget = target;
		target?.classList.add("player-fullscreen");
		if (!target) {
			restoreScroll?.();
			restoreScroll = undefined;
		}
		onChange(!!target);
	}

	function syncNativeState() {
		const current = nativeElement();
		const target = getTarget();
		if (!disposed && target && current && target.contains(current)) {
			fallback = false;
			setActive(target);
		} else if (!fallback && !requesting) {
			setActive(null);
		}
	}

	async function exitNative() {
		const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
		if (nativeElement() && exit) {
			try {
				await exit.call(doc);
			} catch {
				// The browser may already be leaving fullscreen (Escape or navigation).
			}
		}
	}

	async function enter(): Promise<boolean> {
		const target = getTarget() as FullscreenElement | null;
		if (disposed || activeTarget || !target) {
			return !!activeTarget;
		}
		const requestGeneration = ++generation;
		setActive(target);
		const request = target.requestFullscreen ?? target.webkitRequestFullscreen;
		fallback = !request;
		if (!request) {
			return false;
		}
		requesting = true;
		try {
			await request.call(target);
			fallback = !nativeElement();
		} catch {
			// Keep a usable player-only fullscreen when the browser denies the API.
			fallback = true;
		} finally {
			requesting = false;
		}
		if (disposed || requestGeneration !== generation) {
			await exitNative();
			fallback = false;
			setActive(null);
			return false;
		}
		return !!nativeElement();
	}

	async function exit() {
		generation++;
		fallback = false;
		const current = nativeElement();
		const target = getTarget();
		setActive(null);
		if (target && current && target.contains(current)) {
			await exitNative();
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		if (
			event.key === "Escape" &&
			activeTarget &&
			fallback &&
			!event.defaultPrevented &&
			!doc.querySelector(
				".chat.activated, .settings-menu-container, .v-dialog.v-overlay--active, .v-menu.v-overlay--active",
			)
		) {
			event.preventDefault();
			void exit();
		}
	}

	doc.addEventListener("fullscreenchange", syncNativeState);
	doc.addEventListener("webkitfullscreenchange", syncNativeState);
	doc.addEventListener("keydown", onKeyDown);
	return {
		enter,
		exit,
		toggle: async () => {
			if (activeTarget) {
				await exit();
			} else {
				await enter();
			}
		},
		dispose() {
			disposed = true;
			void exit();
			doc.removeEventListener("fullscreenchange", syncNativeState);
			doc.removeEventListener("webkitfullscreenchange", syncNativeState);
			doc.removeEventListener("keydown", onKeyDown);
		},
	};
}
