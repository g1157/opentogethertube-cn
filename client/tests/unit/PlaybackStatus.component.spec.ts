import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { PlayerStatus } from "ott-common/models/types";
import PlaybackStatus from "@/components/WorkaroundPlaybackStatusUpdater.vue";
import { PlayerActionsKey } from "@/util/player-actions";
import { mountComponent } from "./component-test-utils";

describe("playback status telemetry", () => {
	let page: ReturnType<typeof mountComponent>;
	let hidden = false;
	const blocked = ref(false);
	beforeEach(async () => {
		vi.useFakeTimers();
		hidden = false;
		blocked.value = false;
		vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
		page = mountComponent(PlaybackStatus, {
			global: { provide: { [PlayerActionsKey as symbol]: { playbackBlocked: blocked } } },
		});
		page.connection.connected.value = true;
		await nextTick();
		page.connection.sent.length = 0;
	});
	afterEach(() => {
		page.wrapper.unmount();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	async function report(status: PlayerStatus) {
		page.store.commit("PLAYBACK_STATUS", status);
		await vi.advanceTimersByTimeAsync(200);
	}

	it("reports the new Vuex state and suppresses duplicate reports", async () => {
		await report(PlayerStatus.buffering);
		await report(PlayerStatus.buffering);
		expect(page.connection.sent).toEqual([
			{ action: "status", status: PlayerStatus.buffering },
		]);
	});

	it("clears a foreground buffering report on hide and immediately restores it on show", async () => {
		await report(PlayerStatus.buffering);
		hidden = true;
		document.dispatchEvent(new Event("visibilitychange"));
		expect(page.connection.sent.at(-1)).toEqual({
			action: "status",
			status: PlayerStatus.ready,
		});
		await report(PlayerStatus.buffering);
		expect(page.connection.sent).toHaveLength(2);
		hidden = false;
		document.dispatchEvent(new Event("visibilitychange"));
		expect(page.connection.sent.at(-1)).toEqual({
			action: "status",
			status: PlayerStatus.buffering,
		});
	});

	it("does not turn an autoplay-blocked client into a buffer-gate waiter", async () => {
		blocked.value = true;
		await nextTick();
		await report(PlayerStatus.buffering);
		expect(page.connection.sent.at(-1)).toEqual({
			action: "status",
			status: PlayerStatus.none,
		});
		blocked.value = false;
		await nextTick();
		expect(page.connection.sent.at(-1)).toEqual({
			action: "status",
			status: PlayerStatus.buffering,
		});
	});

	it("preserves terminal errors while hidden", async () => {
		hidden = true;
		await report(PlayerStatus.error);
		expect(page.connection.sent.at(-1)).toEqual({
			action: "status",
			status: PlayerStatus.error,
		});
	});

	it("resends current state after reconnecting", async () => {
		await report(PlayerStatus.buffering);
		page.connection.connected.value = false;
		await nextTick();
		page.connection.sent.length = 0;
		page.connection.connected.value = true;
		await nextTick();
		expect(page.connection.sent).toEqual([
			{ action: "status", status: PlayerStatus.buffering },
		]);
	});

	it("cancels pending sends and visibility listeners on unmount", async () => {
		page.store.commit("PLAYBACK_STATUS", PlayerStatus.buffering);
		page.wrapper.unmount();
		await vi.advanceTimersByTimeAsync(500);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(page.connection.sent).toEqual([]);
	});
});
