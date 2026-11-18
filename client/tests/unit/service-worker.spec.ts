import { afterEach, describe, expect, it, vi } from "vitest";
import { installServiceWorker } from "@/util/service-worker";

describe("service worker registration", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("registers the worker once the page has loaded", async () => {
		const register = vi.fn().mockResolvedValue({});
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: { register },
		});
		installServiceWorker();
		expect(register).not.toHaveBeenCalled();

		window.dispatchEvent(new Event("load"));
		await Promise.resolve();
		expect(register).toHaveBeenCalledWith("/sw.js");
	});

	it("does nothing without service worker support", () => {
		Reflect.deleteProperty(navigator, "serviceWorker");
		expect(() => installServiceWorker()).not.toThrow();
	});

	it("registers the worker under the configured application base", async () => {
		vi.stubEnv("BASE_URL", "/watch/");
		const register = vi.fn().mockResolvedValue({});
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: { register },
		});
		installServiceWorker();
		window.dispatchEvent(new Event("load"));
		await Promise.resolve();
		expect(register).toHaveBeenCalledWith("/watch/sw.js");
	});
});
