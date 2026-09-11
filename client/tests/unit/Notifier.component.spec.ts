import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Notifier from "@/components/Notifier.vue";
import { ToastStyle } from "@/models/toast";
import { RoomRequestType } from "ott-common/models/messages";
import { mountComponent } from "./component-test-utils";

describe("Notifier component", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders a toast notification", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test" });
		await wrapper.vm.$nextTick();

		expect(store.state.toast.notifications).toHaveLength(1);
	});

	it("renders a toast notification with a custom duration", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test", duration: 1000 });
		await wrapper.vm.$nextTick();
		expect(store.state.toast.notifications).toHaveLength(1);

		vi.advanceTimersByTime(1000);
		await wrapper.vm.$nextTick();

		expect(store.state.toast.notifications).toHaveLength(0);
	});

	it("expires join/leave and seek notices using the viewer's separate durations", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("settings/UPDATE", { presenceNoticeSeconds: 1, seekNoticeSeconds: 2 });
		for (const type of [
			RoomRequestType.JoinRequest,
			RoomRequestType.LeaveRequest,
			RoomRequestType.SeekRequest,
		]) {
			await store.dispatch("event", {
				request: { type, value: 123 },
				user: { name: "Alice" },
				additional: { user: { name: "Bob" } },
			});
		}
		await wrapper.vm.$nextTick();
		expect(store.state.toast.notifications).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.state.toast.notifications).toHaveLength(1);
		expect(store.state.toast.notifications[0].event?.request.type).toBe(
			RoomRequestType.SeekRequest,
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.state.toast.notifications).toHaveLength(0);
	});

	it("can disable room activity notices without hiding errors", async () => {
		const { store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("settings/UPDATE", { presenceNoticeSeconds: 0, seekNoticeSeconds: 0 });
		for (const type of [
			RoomRequestType.JoinRequest,
			RoomRequestType.LeaveRequest,
			RoomRequestType.SeekRequest,
		]) {
			await store.dispatch("event", {
				request: { type, value: 123 },
				user: { name: "Alice" },
				additional: { user: { name: "Bob" } },
			});
		}
		expect(store.state.toast.notifications).toHaveLength(0);
		await store.dispatch("error", { error: "Video unavailable" });
		expect(store.state.toast.notifications).toHaveLength(1);
		expect(store.state.toast.notifications[0].style).toBe(ToastStyle.Error);
	});

	for (const [toastStyle, className] of [
		[ToastStyle.Success, "bg-success"],
		[ToastStyle.Error, "bg-error"],
	] as const) {
		it(`renders a toast notification with ${className} style`, async () => {
			const { wrapper, store } = mountComponent(Notifier);
			store.commit("toast/CLEAR_ALL_TOASTS");
			store.commit("toast/ADD_TOAST", { content: "test", style: toastStyle });
			await wrapper.vm.$nextTick();

			expect(wrapper.get(".toast").classes()).toContain(className);
		});
	}

	it("renders toast structure used for dynamic sizing", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test", duration: 1000 });
		await wrapper.vm.$nextTick();

		expect(wrapper.get(".toast-content").text()).toContain("test");
		expect((wrapper.get(".bar").element as HTMLElement).style.animationDuration).toBe("1000ms");
	});

	it("shows a close all button if there is more than 1 toast", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test" });
		store.commit("toast/ADD_TOAST", { content: "test" });
		await wrapper.vm.$nextTick();

		expect(store.state.toast.notifications).toHaveLength(2);
		await wrapper.get('[data-cy="toast-close-all"]').trigger("click");

		expect(store.state.toast.notifications).toHaveLength(0);
	});
});
