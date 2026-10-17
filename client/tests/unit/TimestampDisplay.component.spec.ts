import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import TimestampDisplay from "@/components/controls/TimestampDisplay.vue";
import { mountComponent } from "./component-test-utils";

describe("timestamp display length", () => {
	it("shows the server-provided length", async () => {
		const { wrapper, store } = mountComponent(TimestampDisplay);
		store.commit("room/SYNC", {
			currentSource: { service: "direct", id: "test.mp4", length: 305 },
		});
		await nextTick();
		expect(wrapper.find(".video-length").text()).toBe("05:05");
	});

	it("falls back to the locally measured duration for an unknown length", async () => {
		const { wrapper, store } = mountComponent(TimestampDisplay);
		store.commit("room/SYNC", { currentSource: { service: "direct", id: "test.mp4" } });
		store.commit("PLAYBACK_DURATION", 125);
		await nextTick();
		expect(wrapper.find(".video-length").text()).toBe("02:05");
	});
});
