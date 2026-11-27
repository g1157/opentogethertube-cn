import { describe, expect, it, vi } from "vitest";
import PeertubePlayer from "@/components/players/PeertubePlayer.vue";
import { flush, mountComponent } from "./component-test-utils";

/**
 * The SDK posts messages over a jschannel inside a real iframe, which jsdom cannot host. The
 * teardown is about the object this component owns, so a stand-in that records its
 * registrations is enough.
 */
const sdk = vi.hoisted(() => {
	class FakeEmbed {
		ready = Promise.resolve();
		destroy = vi.fn();
		listeners = new Map<string, (status: string) => void>();
		addEventListener = vi.fn((event: string, handler: (status: string) => void) => {
			this.listeners.set(event, handler);
			return true;
		});
		removeEventListener = vi.fn((event: string) => {
			this.listeners.delete(event);
			return true;
		});

		constructor(_element: HTMLElement) {
			instances.push(this);
		}
	}

	const instances: FakeEmbed[] = [];
	return { FakeEmbed, instances };
});

vi.mock("@peertube/embed-api", () => ({ PeerTubePlayer: sdk.FakeEmbed }));

describe("PeerTube embed teardown", () => {
	it("removes its playback listener and destroys the player on unmount", async () => {
		const { wrapper } = mountComponent(PeertubePlayer, {
			props: { videoId: "video.example.com:9c9b1b1e-0000-0000-0000-000000000000" },
		});
		await flush();
		await new Promise(resolve => setTimeout(resolve, 0));

		const embed = sdk.instances.at(-1);
		expect(embed).toBeDefined();
		const handler = embed?.addEventListener.mock.calls[0]?.[1];
		expect(handler).toBeTypeOf("function");
		expect(embed?.addEventListener).toHaveBeenCalledWith("playbackStatusChange", handler);
		expect(embed?.destroy).not.toHaveBeenCalled();

		wrapper.unmount();

		// The SDK holds the handler in its own registry, not in the iframe: without this the
		// closure — and this component's reactive state — outlives the embed.
		expect(embed?.removeEventListener).toHaveBeenCalledWith(
			"playbackStatusChange",
			handler,
		);
		expect(embed?.listeners.has("playbackStatusChange")).toBe(false);
		// The embed API does provide destroy(), so the teardown must use it.
		expect(embed?.destroy).toHaveBeenCalledTimes(1);
	});
});
