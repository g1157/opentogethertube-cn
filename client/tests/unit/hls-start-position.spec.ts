import Hls from "hls.js";
import { describe, expect, it, vi } from "vitest";

/**
 * A startLoad issued before the manifest is parsed only arms hls.js' forced start; the
 * manifest handler then calls startLoad(config.startPosition) and discards that argument.
 * These assertions run against the real library so an upgrade that changes this is noticed.
 */
describe("hls.js configured start position", () => {
	it("restarts a forced early startLoad from config.startPosition", () => {
		const hls = new Hls({ autoStartLoad: false, startPosition: 1234.5 });
		try {
			hls.startLoad(0);
			const startLoad = vi.spyOn(hls, "startLoad");
			const controller = (
				hls as unknown as {
					networkControllers: { checkAutostartLoad?: () => void }[];
				}
			).networkControllers.find(
				candidate => typeof candidate.checkAutostartLoad === "function",
			);
			expect(controller).toBeDefined();

			controller?.checkAutostartLoad?.();

			expect(startLoad).toHaveBeenCalledWith(1234.5);
		} finally {
			hls.destroy();
		}
	});
});
