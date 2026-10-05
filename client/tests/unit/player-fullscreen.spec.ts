import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPlayerFullscreen,
	PORTRAIT_QUERY,
	type PlayerFullscreen,
} from "@/util/player-fullscreen";
import { PHONE_MAX_QUERY } from "@/util/breakpoints";

describe("player fullscreen", () => {
	let nativeElement: Element | null;
	let target: HTMLDivElement;
	let controller: PlayerFullscreen;
	let onChange: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		nativeElement = null;
		target = document.createElement("div");
		target.innerHTML = "<video></video><button>Controls</button>";
		document.body.appendChild(target);
		document.body.style.overflow = "auto";
		vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		vi.spyOn(window, "scrollY", "get").mockReturnValue(345);
		Object.defineProperty(document, "fullscreenElement", {
			configurable: true,
			get: () => nativeElement,
		});
		// eslint-disable-next-line vitest/prefer-spy-on -- jsdom does not provide this native API.
		document.exitFullscreen = vi.fn(async () => {
			nativeElement = null;
			document.dispatchEvent(new Event("fullscreenchange"));
		});
		onChange = vi.fn();
		controller = createPlayerFullscreen(() => target, onChange);
	});

	afterEach(() => {
		controller.dispose();
		document.body.innerHTML = "";
		document.body.removeAttribute("style");
		document.documentElement.removeAttribute("style");
		Reflect.deleteProperty(document, "fullscreenElement");
		Reflect.deleteProperty(document, "exitFullscreen");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function stubPhoneViewport() {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === PHONE_MAX_QUERY,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
	}

	it("locks a phone into landscape on fullscreen and unlocks on exit", async () => {
		const lock = vi.fn(async () => undefined);
		const unlock = vi.fn();
		vi.stubGlobal("screen", { orientation: { lock, unlock } });
		stubPhoneViewport();
		// eslint-disable-next-line vitest/prefer-spy-on -- jsdom does not provide this native API.
		target.requestFullscreen = vi.fn(async () => {
			nativeElement = target;
			document.dispatchEvent(new Event("fullscreenchange"));
		});

		await controller.enter();
		expect(lock).toHaveBeenCalledWith("landscape");
		// The lock turns the screen itself; the player must not turn as well.
		expect(target.classList.contains("player-rotated")).toBe(false);

		await controller.exit();
		expect(unlock).toHaveBeenCalledOnce();
	});

	it("turns a portrait phone's fallback fullscreen a quarter and follows the device back", async () => {
		// iOS: no element fullscreen and no orientation lock, so the fallback is rotated to
		// give the wide picture the moment the button is tapped.
		let portrait = true;
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === PHONE_MAX_QUERY || (query === PORTRAIT_QUERY && portrait),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
		vi.stubGlobal("screen", {});

		await controller.enter();
		expect(target.classList.contains("player-rotated")).toBe(true);
		expect(target.classList.contains("player-fullscreen")).toBe(true);

		// The device really turns to landscape: the quarter turn goes, fullscreen stays.
		portrait = false;
		window.dispatchEvent(new Event("orientationchange"));
		expect(target.classList.contains("player-rotated")).toBe(false);
		expect(target.classList.contains("player-fullscreen")).toBe(true);

		// Back to portrait while still fullscreen: the quarter turn returns.
		portrait = true;
		window.dispatchEvent(new Event("resize"));
		expect(target.classList.contains("player-rotated")).toBe(true);

		await controller.exit();
		expect(target.classList.contains("player-rotated")).toBe(false);
	});

	it("leaves desktop orientation alone and survives a browser without the lock", async () => {
		const lock = vi.fn(async () => undefined);
		vi.stubGlobal("screen", { orientation: { lock, unlock: vi.fn() } });
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
		// eslint-disable-next-line vitest/prefer-spy-on -- jsdom does not provide this native API.
		target.requestFullscreen = vi.fn(async () => {
			nativeElement = target;
			document.dispatchEvent(new Event("fullscreenchange"));
		});
		await controller.enter();
		expect(lock).not.toHaveBeenCalled();

		// iOS ships no lock at all; entering fullscreen must still work there.
		vi.stubGlobal("screen", {});
		await controller.exit();
		await expect(controller.enter()).resolves.toBe(true);
	});

	it("requests native fullscreen for the player and restores the page on browser exit", async () => {
		// eslint-disable-next-line vitest/prefer-spy-on -- jsdom does not provide this native API.
		target.requestFullscreen = vi.fn(async () => {
			nativeElement = target;
			document.dispatchEvent(new Event("fullscreenchange"));
		});
		await controller.enter();
		expect(nativeElement).toBe(target);
		expect(target.requestFullscreen).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenLastCalledWith(true);
		expect(document.body.style.position).toBe("fixed");
		nativeElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));
		expect(onChange).toHaveBeenLastCalledWith(false);
		expect(document.body.style.overflow).toBe("auto");
		expect(document.body.style.position).toBe("");
		expect(window.scrollTo).toHaveBeenLastCalledWith({
			left: 0,
			top: 345,
			behavior: "instant",
		});
	});

	it("locks background touch scrolling without the native API and exits with Escape", async () => {
		await controller.enter();
		expect(target.classList.contains("player-fullscreen")).toBe(true);
		expect(document.documentElement.style.overflow).toBe("hidden");
		expect(document.body.style.position).toBe("fixed");
		expect(document.body.style.top).toBe("-345px");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(target.classList.contains("player-fullscreen")).toBe(false);
		expect(document.documentElement.style.overflow).toBe("");
		expect(document.body.style.overflow).toBe("auto");
	});

	it("falls back when the browser rejects fullscreen and still supports the exit button", async () => {
		// eslint-disable-next-line vitest/prefer-spy-on -- jsdom does not provide this native API.
		target.requestFullscreen = vi.fn().mockRejectedValue(new Error("Not allowed"));
		await expect(controller.toggle()).resolves.toBeUndefined();
		expect(onChange).toHaveBeenLastCalledWith(true);
		await controller.toggle();
		expect(onChange).toHaveBeenLastCalledWith(false);
		expect(document.body.style.position).toBe("");
	});

	it("cleans up scrolling and listeners when leaving the room in fallback fullscreen", async () => {
		await controller.enter();
		controller.dispose();
		expect(onChange).toHaveBeenLastCalledWith(false);
		expect(document.body.style.position).toBe("");
		onChange.mockClear();
		nativeElement = target;
		document.dispatchEvent(new Event("fullscreenchange"));
		expect(onChange).not.toHaveBeenCalled();
		await controller.enter();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("exits a delayed native request if the room is left before it completes", async () => {
		let completeRequest: () => void = () => undefined;
		// eslint-disable-next-line vitest/prefer-spy-on -- jsdom does not provide this native API.
		target.requestFullscreen = vi.fn(
			() =>
				new Promise<void>(resolve => {
					completeRequest = () => {
						nativeElement = target;
						resolve();
					};
				}),
		);
		const pending = controller.enter();
		controller.dispose();
		completeRequest();
		await pending;
		expect(document.exitFullscreen).toHaveBeenCalledOnce();
		expect(nativeElement).toBeNull();
		expect(document.body.style.position).toBe("");
	});
});
