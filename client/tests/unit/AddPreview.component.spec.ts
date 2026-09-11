import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AddPreview from "@/components/AddPreview.vue";
import { flush, mountComponent } from "./component-test-utils";
import { i18n } from "@/i18n";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/common-http", () => ({ API }));

describe("AddPreview component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		API.get.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("immediately makes a single query if given a URL", async () => {
		API.get.mockResolvedValueOnce({
			data: {
				success: true,
				result: [
					{ service: "youtube", id: "1", title: "Foo", description: "Bar", length: 100 },
				],
			},
		});
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;

		store.state.production = true;
		await wrapper.vm.$nextTick();
		await wrapper
			.get('[data-cy="add-preview-input"] textarea')
			.setValue("https://youtube.com/watch?v=LP8GRjv6AIo");
		await new Promise(resolve => setTimeout(resolve, 1100));
		await flush();

		expect(API.get).toHaveBeenCalledWith(
			"/data/previewAdd?input=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3DLP8GRjv6AIo",
			expect.objectContaining({ timeout: 45000, signal: expect.any(AbortSignal) }),
		);
		expect(wrapper.findAll(".video")).toHaveLength(1);
	});

	it("does not query non-URLs until manual search", async () => {
		API.get.mockResolvedValueOnce({
			data: {
				success: true,
				result: [
					{ service: "youtube", id: "1", title: "Foo", description: "Bar", length: 100 },
				],
			},
		});
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;

		store.state.production = true;
		await wrapper.vm.$nextTick();
		await wrapper.get('[data-cy="add-preview-input"] textarea').setValue("foo");
		await flush();
		expect(API.get).not.toHaveBeenCalled();

		await wrapper.get('[data-cy="add-preview-manual-search"]').trigger("click");
		await flush();

		expect(API.get).toHaveBeenCalledWith("/data/previewAdd?input=foo", expect.any(Object));
		expect(wrapper.findAll(".video")).toHaveLength(1);
	});

	it("does not show test videos in prod environment", async () => {
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-cy="test-video"]').exists()).toBe(false);
	});

	it("stops a request that never responds, explains the timeout, and allows retry", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		API.get.mockImplementation(() => new Promise(() => undefined));
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;
		await wrapper
			.get('[data-cy="add-preview-input"] textarea')
			.setValue("https://example.com/slow.mp4");
		await vi.advanceTimersByTimeAsync(1000);
		const { signal } = API.get.mock.calls[0][1];
		await vi.advanceTimersByTimeAsync(8000);
		expect(wrapper.get('[data-cy="add-preview-loading"]').text()).toContain(
			i18n.global.t("add-preview.loading-slow"),
		);
		await vi.advanceTimersByTimeAsync(37000);
		expect(signal.aborted).toBe(true);
		expect(wrapper.find('[data-cy="add-preview-loading"]').exists()).toBe(false);
		expect(wrapper.get('[data-cy="add-preview-error"]').text()).toContain(
			i18n.global.t("add-preview.messages.timeout"),
		);
		API.get.mockResolvedValueOnce({ data: { success: true, result: [] } });
		await wrapper.get('[data-cy="add-preview-retry"]').trigger("click");
		await flush();
		expect(API.get).toHaveBeenCalledTimes(2);
		expect(wrapper.find('[data-cy="add-preview-error"]').exists()).toBe(false);
	});

	it("cancels an older lookup and ignores its late result while the new link loads", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let first!: (response: unknown) => void;
		let second!: (response: unknown) => void;
		API.get.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					first = resolve;
				}),
		);
		API.get.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					second = resolve;
				}),
		);
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;
		const input = wrapper.get('[data-cy="add-preview-input"] textarea');
		await input.setValue("https://example.com/old.mp4");
		await vi.advanceTimersByTimeAsync(1000);
		const { signal } = API.get.mock.calls[0][1];
		await input.setValue("https://example.com/new.mp4");
		await vi.advanceTimersByTimeAsync(1000);
		expect(signal.aborted).toBe(true);
		first({
			data: { success: true, result: [{ service: "direct", id: "old", title: "Old video" }] },
		});
		await flush();
		expect(wrapper.find('[data-cy="add-preview-loading"]').exists()).toBe(true);
		expect(wrapper.findAll(".video")).toHaveLength(0);
		second({
			data: { success: true, result: [{ service: "direct", id: "new", title: "New video" }] },
		});
		await flush();
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-cy="add-preview-loading"]').exists()).toBe(false);
		expect(wrapper.text()).toContain("New video");
		expect(wrapper.text()).not.toContain("Old video");
	});

	it("clearing the input cancels pending and in-flight lookups", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		API.get.mockImplementation(() => new Promise(() => undefined));
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;
		const input = wrapper.get('[data-cy="add-preview-input"] textarea');
		await input.setValue("https://example.com/cancel.mp4");
		await input.setValue("");
		await vi.advanceTimersByTimeAsync(1000);
		expect(API.get).not.toHaveBeenCalled();
		await input.setValue("https://example.com/cancel.mp4");
		await vi.advanceTimersByTimeAsync(1000);
		const { signal } = API.get.mock.calls[0][1];
		await input.setValue("");
		expect(signal.aborted).toBe(true);
		expect(wrapper.find('[data-cy="add-preview-loading"]').exists()).toBe(false);
		await vi.advanceTimersByTimeAsync(45000);
		expect(wrapper.find('[data-cy="add-preview-error"]').exists()).toBe(false);
	});
});
