import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { BufferGateMode, PlayerStatus, Role } from "ott-common/models/types";
import BufferGateNotice from "@/components/BufferGateNotice.vue";
import { mountComponent } from "./component-test-utils";

describe("buffer gate notice", () => {
	it("shows eligible buffering names only while the enabled room is paused", async () => {
		const { wrapper, store } = mountComponent(BufferGateNotice);
		store.state.room.grants.setRoleGrants(Role.UnregisteredUser, ["playback.play-pause"]);
		store.commit("room/SYNC", {
			bufferGateMode: BufferGateMode.Pause,
			isPlaying: false,
			currentSource: { service: "direct", id: "test.mp4" },
		});
		store.commit("users/INIT_USERS", [
			{ id: "alice", name: "Alice", role: Role.UnregisteredUser, status: PlayerStatus.ready },
			{ id: "bob", name: "Bob", role: Role.UnregisteredUser, status: PlayerStatus.buffering },
			{ id: "carol", name: "Carol", role: Role.UnregisteredUser, status: PlayerStatus.error },
		]);
		await nextTick();
		expect(wrapper.text()).toContain("Bob");
		expect(wrapper.text()).not.toContain("Carol");
		store.commit("room/SYNC", { isPlaying: true });
		await nextTick();
		expect(wrapper.find('[data-cy="buffer-gate-notice"]').exists()).toBe(false);
		store.commit("room/SYNC", { isPlaying: false, bufferGateMode: BufferGateMode.Off });
		await nextTick();
		expect(wrapper.find('[data-cy="buffer-gate-notice"]').exists()).toBe(false);
	});
});
