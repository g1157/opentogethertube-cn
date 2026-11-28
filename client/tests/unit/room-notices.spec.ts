import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { useRoomNotices } from "@/components/composables/room-notices";
import { MIN_PLAYER_BRIGHTNESS, usePlayerBrightness } from "@/util/player-brightness";

describe("room gesture notices", () => {
	let wrapper: { unmount(): void } | null = null;
	let notices: ReturnType<typeof useRoomNotices>;
	let volume = 50;
	const brightness = usePlayerBrightness();
	// Readable stand-in for the interface strings: the message keys are what has to match.
	const t = (key: string, named?: Record<string, unknown>) =>
		named ? `${key} ${String(named.value)}` : key;

	beforeEach(() => {
		vi.useFakeTimers();
		volume = 50;
		brightness.setBrightness(1);
		wrapper = mount(
			defineComponent({
				setup() {
					notices = useRoomNotices({
						t,
						brightness,
						getVolume: () => volume,
						setVolume: percent => {
							volume = percent;
						},
					});
					return () => h("div");
				},
			}),
		);
	});
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
		brightness.setBrightness(1);
		vi.useRealTimers();
	});

	it("shows an interaction message and clears it after two seconds", () => {
		notices.showInteractionNotice("play-pause-denied");
		expect(notices.interactionNotice.value).toBe("player.interactions.play-pause-denied");

		vi.advanceTimersByTime(1999);
		expect(notices.interactionNotice.value).not.toBe("");
		vi.advanceTimersByTime(1);
		expect(notices.interactionNotice.value).toBe("");
	});

	it("restarts the two second timer when another message arrives", () => {
		notices.showInteractionNotice("speed-denied");
		vi.advanceTimersByTime(1500);
		notices.showInteractionNotice("speed-busy");

		vi.advanceTimersByTime(1999);
		expect(notices.interactionNotice.value).toBe("player.interactions.speed-busy");
		vi.advanceTimersByTime(1);
		expect(notices.interactionNotice.value).toBe("");
	});

	it("dims the picture on the left half and reports the rounded brightness", () => {
		notices.onLevelMove("left", -0.26);

		expect(brightness.brightness.value).toBeCloseTo(0.74, 5);
		expect(notices.levelNotice.value).toBe("player.interactions.level-brightness 74");
		expect(volume).toBe(50);
	});

	it("clamps the brightness at the darkest the panel can go", () => {
		notices.onLevelMove("left", -2);

		expect(brightness.brightness.value).toBeCloseTo(MIN_PLAYER_BRIGHTNESS, 5);
		expect(notices.levelNotice.value).toBe("player.interactions.level-brightness 20");
	});

	it("moves the volume on the right half and reports the committed percentage", () => {
		notices.onLevelMove("right", -0.17);

		expect(volume).toBe(33);
		expect(notices.levelNotice.value).toBe("player.interactions.level-volume 33");
		expect(brightness.brightness.value).toBe(1);
	});

	it("clamps the volume between zero and one hundred", () => {
		notices.onLevelMove("right", 2);
		expect(volume).toBe(100);

		notices.onLevelMove("right", -5);
		expect(volume).toBe(0);
		expect(notices.levelNotice.value).toBe("player.interactions.level-volume 0");
	});

	it("keeps the level read-out for 800 ms after the finger leaves", () => {
		notices.onLevelMove("left", -0.2);
		notices.onLevelEnd();

		vi.advanceTimersByTime(799);
		expect(notices.levelNotice.value).toBe("player.interactions.level-brightness 80");
		vi.advanceTimersByTime(1);
		expect(notices.levelNotice.value).toBe("");
	});

	it("cancels the pending clear when a new level gesture starts", () => {
		notices.onLevelMove("left", -0.2);
		notices.onLevelEnd();
		vi.advanceTimersByTime(400);
		notices.onLevelStart();

		vi.advanceTimersByTime(1000);
		expect(notices.levelNotice.value).toBe("player.interactions.level-brightness 80");
	});
});
