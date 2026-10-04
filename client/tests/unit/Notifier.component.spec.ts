import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Notifier from "@/components/Notifier.vue";
import { ToastStyle } from "@/models/toast";
import { RoomRequestType } from "ott-common/models/messages";
import { fullscreenNoticeHost } from "@/util/toast";
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

	describe("fullscreen notices", () => {
		function withHost(store: ReturnType<typeof mountComponent>["store"]) {
			const host = document.createElement("div");
			document.body.append(host);
			fullscreenNoticeHost.value = host;
			store.commit("SET_FULLSCREEN", true);
			return host;
		}

		function teleportedText() {
			return [...document.querySelectorAll(".toast-list--fullscreen .toast")]
				.map(node => node.textContent ?? "")
				.join(" ");
		}

		beforeEach(() => {
			document.body.innerHTML = "";
			fullscreenNoticeHost.value = null;
		});

		afterEach(() => {
			fullscreenNoticeHost.value = null;
			document.body.innerHTML = "";
		});

		it("teleports notices into the player and keeps critical and content levels", async () => {
			const { wrapper, store } = mountComponent(Notifier);
			store.commit("toast/CLEAR_ALL_TOASTS");
			withHost(store);
			store.commit("toast/ADD_TOAST", { content: "error", level: "critical" });
			store.commit("toast/ADD_TOAST", { content: "played", level: "content" });
			store.commit("toast/ADD_TOAST", { content: "joined" });
			await wrapper.vm.$nextTick();

			const text = teleportedText();
			expect(text).toContain("error");
			expect(text).toContain("played");
			expect(text).not.toContain("joined");
		});

		it("caps the stack and counts what it hid", async () => {
			const { wrapper, store } = mountComponent(Notifier);
			store.commit("toast/CLEAR_ALL_TOASTS");
			withHost(store);
			store.commit("toast/ADD_TOAST", { content: "one", level: "content" });
			store.commit("toast/ADD_TOAST", { content: "two", level: "content" });
			store.commit("toast/ADD_TOAST", { content: "three", level: "content" });
			store.commit("toast/ADD_TOAST", { content: "four", level: "content" });
			await wrapper.vm.$nextTick();

			// Newest first, and the older notices collapse into the counter.
			const text = teleportedText();
			expect(text).toContain("three");
			expect(text).toContain("four");
			expect(text).not.toContain("one");
			expect(document.querySelector(".toast-more")?.textContent).toContain("2");
		});

		it("caps the windowed stack instead of letting bursts pile up", async () => {
			const { wrapper, store } = mountComponent(Notifier);
			store.commit("toast/CLEAR_ALL_TOASTS");
			for (const content of ["one", "two", "three", "four", "five", "six"]) {
				store.commit("toast/ADD_TOAST", { content });
			}
			await wrapper.vm.$nextTick();

			expect(wrapper.find(".toast-list--fullscreen").exists()).toBe(false);
			// Newest first; the older cards collapse into the counter instead of stacking up.
			const rendered = wrapper.findAll(".toast").map(node => node.text());
			expect(rendered).toHaveLength(4);
			expect(rendered.join(" ")).toContain("six");
			expect(rendered.join(" ")).not.toContain("one");
			expect(wrapper.get(".toast-more").text()).toContain("2");
			// The hidden cards stay in the state and keep expiring on their own.
			expect(store.state.toast.notifications).toHaveLength(6);
		});
	});
});
