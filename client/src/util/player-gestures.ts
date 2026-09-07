import { ref } from "vue";

interface PlayerGestureOptions {
	getPosition(): number;
	getBounds(): { start: number; end: number } | null;
	getSeekStep(): number;
	canSeek(): boolean;
	isPlaying(): boolean;
	onTap(): void;
	onDoubleClick(): void;
	onSeek(position: number): void;
	onSeekDenied(): void;
	onHoldStart(): boolean;
	onHoldEnd(): void;
}

interface Gesture {
	id: number;
	pointerType: string;
	element: HTMLElement;
	x: number;
	y: number;
	position: number;
	moved: boolean;
	phase: "pending" | "swiping" | "holding" | "cancelled";
}

/** A single pointer owns a gesture. Only pointer-up commits a horizontal seek. */
export function createPlayerGestures(options: PlayerGestureOptions) {
	const preview = ref<{ position: number; delta: number } | null>(null);
	let gesture: Gesture | null = null;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let clickTimer: ReturnType<typeof setTimeout> | null = null;
	let lastClick: { x: number; y: number; time: number } | null = null;

	function clearHoldTimer() {
		if (holdTimer !== null) {
			clearTimeout(holdTimer);
		}
		holdTimer = null;
	}

	function clearClickTimer() {
		if (clickTimer !== null) {
			clearTimeout(clickTimer);
		}
		clickTimer = null;
		lastClick = null;
	}

	function releasePointer(current: Gesture | null) {
		if (current?.element.hasPointerCapture?.(current.id)) {
			current.element.releasePointerCapture(current.id);
		}
	}

	function cancel() {
		clearHoldTimer();
		clearClickTimer();
		const current = gesture;
		gesture = null;
		preview.value = null;
		if (current?.phase === "holding") {
			options.onHoldEnd();
		}
		releasePointer(current);
	}

	function pointerDown(event: PointerEvent) {
		if (!event.isPrimary || (gesture && gesture.id !== event.pointerId)) {
			cancel();
			return;
		}
		if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) {
			return;
		}
		// Leave system edge navigation and multi-finger gestures to the browser.
		if (
			event.pointerType !== "mouse" &&
			(event.clientX < 24 || event.clientX > window.innerWidth - 24)
		) {
			return;
		}
		gesture = {
			id: event.pointerId,
			pointerType: event.pointerType,
			element: event.currentTarget,
			x: event.clientX,
			y: event.clientY,
			position: options.getPosition(),
			moved: false,
			phase: "pending",
		};
		event.currentTarget.setPointerCapture?.(event.pointerId);
		if (options.isPlaying()) {
			holdTimer = setTimeout(() => {
				holdTimer = null;
				if (gesture?.phase !== "pending" || gesture.moved) {
					return;
				}
				clearClickTimer();
				gesture.phase = options.onHoldStart() ? "holding" : "cancelled";
			}, 500);
		}
	}

	function pointerMove(event: PointerEvent) {
		const current = gesture;
		if (!current || current.id !== event.pointerId) {
			return;
		}
		const bounds = current.element.getBoundingClientRect();
		if (
			event.clientX < bounds.left ||
			event.clientX > bounds.right ||
			event.clientY < bounds.top ||
			event.clientY > bounds.bottom
		) {
			cancel();
			return;
		}
		if (current.phase === "holding" || current.phase === "cancelled") {
			return;
		}
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (Math.hypot(dx, dy) > 10) {
			current.moved = true;
			clearHoldTimer();
			clearClickTimer();
		}
		if (current.phase === "pending" && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
			current.phase = "cancelled";
			return;
		}
		// Mouse drags are not touch swipes; dragging sliders has its own event surface.
		if (current.pointerType === "mouse") {
			return;
		}
		if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy) * 1.4) {
			preview.value = null;
			return;
		}
		const range = options.getBounds();
		if (!range) {
			current.phase = "cancelled";
			return;
		}
		if (!options.canSeek()) {
			current.phase = "cancelled";
			options.onSeekDenied();
			return;
		}
		current.phase = "swiping";
		event.preventDefault();
		const position = Math.min(
			range.end,
			Math.max(range.start, current.position + Math.sign(dx) * options.getSeekStep()),
		);
		preview.value = { position, delta: position - current.position };
	}

	function pointerUp(event: PointerEvent) {
		const current = gesture;
		if (!current || current.id !== event.pointerId) {
			return;
		}
		clearHoldTimer();
		gesture = null;
		const target = preview.value;
		preview.value = null;
		if (current.phase === "holding") {
			options.onHoldEnd();
		} else if (current.phase === "swiping" && target && options.canSeek()) {
			const range = options.getBounds();
			if (range) {
				options.onSeek(Math.min(range.end, Math.max(range.start, target.position)));
			}
		} else if (current.phase === "pending" && !current.moved) {
			if (current.pointerType !== "mouse") {
				options.onTap();
			} else if (
				lastClick &&
				Date.now() - lastClick.time < 280 &&
				Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) < 12
			) {
				clearClickTimer();
				options.onDoubleClick();
			} else {
				clearClickTimer();
				lastClick = { x: event.clientX, y: event.clientY, time: Date.now() };
				clickTimer = setTimeout(() => {
					clearClickTimer();
					options.onTap();
				}, 280);
			}
		}
		releasePointer(current);
	}

	function pointerCancel(event: PointerEvent) {
		if (gesture?.id === event.pointerId) {
			cancel();
		}
	}

	return { preview, pointerDown, pointerMove, pointerUp, pointerCancel, cancel };
}
