import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayerFullscreen, type PlayerFullscreen } from "@/util/player-fullscreen";

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
		vi.restoreAllMocks();
	});

	it("requests native fullscreen for the player and restores the page on browser exit", async () => {
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
