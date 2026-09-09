import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import type { MediaLoadingState } from "@/util/media-loading-state";
import { mountComponent } from "./component-test-utils";

vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));

describe("direct media stream metadata", () => {
	let page: ReturnType<typeof mountComponent> | undefined;
	let readyState: number;
	let paused: boolean;

	beforeEach(() => {
		readyState = 0;
		paused = true;
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {
			paused = false;
		});
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
			paused = true;
		});
		vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(
			() => readyState,
		);
		vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(600);
		vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(0);
		vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(0);
	});

	afterEach(() => {
		page?.wrapper.unmount();
		page = undefined;
		vi.restoreAllMocks();
	});

	it.each([
		["mp4", "audio/mp4", null],
		["webm", "audio/webm", null],
		["mp4", "video/mp4", "waiting-frame"],
		["webm", "video/webm", "waiting-frame"],
	] as const)("honors probed %s / %s metadata without inferring audio from missing dimensions", async (extension, mime, phase) => {
		page = mountComponent(OmniPlayer, {
			props: {
				source: {
					service: "direct",
					id: `https://media.test/example.${extension}`,
					mime,
					length: 600,
				},
			},
		});
		await flushPromises();
		const player = page.wrapper.getComponent(DirectPlayer);
		const element = page.wrapper.get("video");
		expect(player.props("videoMime")).toBe(mime);
		readyState = 1;
		await element.trigger("loadedmetadata");
		const metadataOnly = page.wrapper
			.emitted("loading-state")
			?.at(-1)?.[0] as MediaLoadingState;
		expect(metadataOnly.phase).not.toBeNull();
		readyState = 3;
		await element.trigger("canplay");
		(element.element as HTMLVideoElement).currentTime = 125;
		await element.trigger("seeking");
		await element.trigger("seeked");
		await (element.element as HTMLVideoElement).play();
		await element.trigger("playing");
		await flushPromises();
		const playable = page.wrapper.emitted("loading-state")?.at(-1)?.[0] as MediaLoadingState;
		expect(playable).toMatchObject({ phase, currentTime: 125 });
		expect(page.wrapper.emitted("playing")).toHaveLength(1);
		expect(page.connection.sent).toEqual([]);
	});
});
