import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import VueSlider from "vue-slider-component";
import { Role } from "ott-common/models/types";
import VideoProgressSlider from "@/components/controls/VideoProgressSlider.vue";
import { mountComponent } from "./component-test-utils";

function mountSlider() {
	const utils = mountComponent(VideoProgressSlider);
	utils.store.state.room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.seek"]);
	return utils;
}

describe("video progress slider length", () => {
	it("stays disabled when neither the server nor the player knows the length", async () => {
		const { wrapper, store } = mountSlider();
		store.commit("room/SYNC", { currentSource: { service: "direct", id: "test.mp4" } });
		await nextTick();
		const slider = wrapper.findComponent(VueSlider);
		expect(slider.props("disabled")).toBe(true);
	});

	it("uses the locally measured duration as its range once known", async () => {
		const { wrapper, store } = mountSlider();
		store.commit("room/SYNC", { currentSource: { service: "direct", id: "test.mp4" } });
		store.commit("PLAYBACK_DURATION", 125.44);
		await nextTick();
		const slider = wrapper.findComponent(VueSlider);
		expect(slider.props("disabled")).toBe(false);
		expect(slider.props("max")).toBe(125.4);
	});

	it("keeps the server length ahead of the local duration", async () => {
		const { wrapper, store } = mountSlider();
		store.commit("room/SYNC", {
			currentSource: { service: "direct", id: "test.mp4", length: 305 },
		});
		store.commit("PLAYBACK_DURATION", 120);
		await nextTick();
		const slider = wrapper.findComponent(VueSlider);
		expect(slider.props("max")).toBe(305);
	});
});
