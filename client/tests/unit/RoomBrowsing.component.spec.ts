import { flushPromises } from "@vue/test-utils";
import type { RoomListItem } from "ott-common/models/rest-api";
import { QueueMode, Visibility } from "ott-common/models/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MyRooms from "@/views/MyRooms.vue";
import RoomList from "@/views/RoomList.vue";
import { mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/common-http", () => ({ API }));

function room(overrides: Partial<RoomListItem> = {}): RoomListItem {
	return {
		name: "movie-night",
		title: "周末一起看",
		description: "Our regular screening room",
		isTemporary: false,
		visibility: Visibility.Public,
		queueMode: QueueMode.Manual,
		currentSource: null,
		users: 0,
		...overrides,
	};
}

function mountOwnedRooms() {
	return mountComponent(MyRooms, {
		global: {
			stubs: {
				VDialog: {
					props: ["modelValue"],
					template: '<div v-if="modelValue" role="dialog"><slot /></div>',
				},
			},
		},
	});
}

function failNextRequest(request: typeof API.get, failure: "network" | "server") {
	if (failure === "network") {
		request.mockRejectedValueOnce(new Error("offline"));
	} else {
		request.mockResolvedValueOnce({
			data: { success: false, error: { name: "Denied", message: "unavailable" } },
		});
	}
}

describe("Room browsing", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("distinguishes a failed public-room request from an empty list and allows retry", async () => {
		API.get
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ data: [room()] });
		const { wrapper } = mountComponent(RoomList);

		await flushPromises();

		expect(wrapper.find('[data-cy="rooms-load-error"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(false);
		expect(wrapper.attributes("aria-busy")).toBe("false");

		await wrapper.get('[data-cy="rooms-load-error"] button').trigger("click");
		await flushPromises();

		expect(API.get).toHaveBeenNthCalledWith(2, "/room/list");
		expect(wrapper.find('[data-cy="rooms-load-error"]').exists()).toBe(false);
		expect(wrapper.findAll('[data-cy="room-card"]')).toHaveLength(1);
	});

	it("shows loading while the public-room request is pending", async () => {
		let finishLoad!: (response: { data: RoomListItem[] }) => void;
		API.get.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					finishLoad = resolve;
				}),
		);
		const { wrapper } = mountComponent(RoomList);
		await wrapper.vm.$nextTick();

		expect(wrapper.attributes("aria-busy")).toBe("true");
		expect(wrapper.find('[role="status"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(false);

		finishLoad({ data: [] });
		await flushPromises();

		expect(wrapper.attributes("aria-busy")).toBe("false");
		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(true);
	});

	it("does not treat an invalid public-room response as an empty list", async () => {
		API.get.mockResolvedValueOnce({ data: { success: false, error: "unavailable" } });
		const { wrapper } = mountComponent(RoomList);
		await flushPromises();

		expect(wrapper.find('[data-cy="rooms-load-error"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(false);
	});

	it("keeps an empty permanent room enterable and renders viewer counts outside thumbnails", async () => {
		API.get.mockResolvedValueOnce({
			data: [
				room({
					currentSource: {
						service: "direct",
						id: "https://media.example/series/03.mp4?signature=private-token",
					},
				}),
				room({ name: "temporary-night", title: "临时放映", isTemporary: true, users: 3 }),
			],
		});
		const { wrapper } = mountComponent(RoomList, {
			global: { stubs: { VImg: true } },
		});
		await flushPromises();

		const cards = wrapper.findAll('[data-cy="room-card"]');
		expect(cards).toHaveLength(2);
		expect(cards[0].attributes("href")).toBe("/room/movie-night");
		expect(cards[0].get(".room-title").text()).toBe("周末一起看");
		expect(cards[0].get('[data-cy="room-viewers"]').text()).toContain("0");
		expect(cards[1].get('[data-cy="room-viewers"]').text()).toContain("3");
		expect(cards[0].get('[data-cy="room-video-title"]').text()).toBe("03.mp4");
		expect(wrapper.html()).not.toContain("private-token");
	});

	it("shows the public-room empty state only after a successful empty response", async () => {
		API.get.mockResolvedValueOnce({ data: [] });
		const { wrapper } = mountComponent(RoomList);
		await flushPromises();

		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="rooms-load-error"]').exists()).toBe(false);
	});

	it.each([
		"network",
		"server",
	] as const)("handles a %s failure when fetching owned rooms and retries", async failure => {
		failNextRequest(API.get, failure);
		API.get.mockResolvedValueOnce({ data: { success: true, data: [room()] } });
		const { wrapper } = mountOwnedRooms();
		await flushPromises();

		expect(wrapper.find('[data-cy="rooms-load-error"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(false);
		await wrapper.get('[data-cy="rooms-load-error"] button').trigger("click");
		await flushPromises();

		expect(API.get).toHaveBeenNthCalledWith(2, "/user/owned-rooms");
		expect(wrapper.findAll('[data-cy="owned-room-entry"]')).toHaveLength(1);
		expect(wrapper.find('[data-cy="rooms-load-error"]').exists()).toBe(false);
	});

	it("keeps owned rooms enterable without presenting database placeholders as live status", async () => {
		API.get.mockResolvedValueOnce({ data: { success: true, data: [room()] } });
		const { wrapper } = mountOwnedRooms();
		await flushPromises();

		expect(wrapper.get('[data-cy="owned-room-entry"]').attributes("href")).toBe(
			"/room/movie-night",
		);
		expect(wrapper.get(".room-title").text()).toBe("周末一起看");
		expect(wrapper.find('[data-cy="room-viewers"]').exists()).toBe(false);
		expect(wrapper.find('[data-cy="room-video-title"]').exists()).toBe(false);
	});

	it("does not offer permanent deletion for a temporary-room item", async () => {
		API.get.mockResolvedValueOnce({
			data: { success: true, data: [room({ isTemporary: true })] },
		});
		const { wrapper } = mountOwnedRooms();
		await flushPromises();

		expect(wrapper.find('[data-cy="delete-room"]').exists()).toBe(false);
		expect(wrapper.find('[data-cy="owned-room-entry"]').exists()).toBe(true);
	});

	it.each([
		"network",
		"server",
	] as const)("keeps the confirmation and room after a %s deletion failure, then permits retry", async failure => {
		API.get.mockResolvedValueOnce({ data: { success: true, data: [room()] } });
		failNextRequest(API.delete, failure);
		API.delete.mockResolvedValueOnce({ data: { success: true } });
		const { wrapper } = mountOwnedRooms();
		await flushPromises();

		await wrapper.get('[data-cy="delete-room"]').trigger("click");
		await flushPromises();
		expect(API.delete).not.toHaveBeenCalled();

		await wrapper.get('[data-cy="confirm-delete-room"]').trigger("click");
		await flushPromises();

		expect(wrapper.find('[data-cy="delete-room-error"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="confirm-delete-room"]').exists()).toBe(true);
		expect(wrapper.findAll('[data-cy="owned-room-entry"]')).toHaveLength(1);

		await wrapper.get('[data-cy="confirm-delete-room"]').trigger("click");
		await flushPromises();

		expect(API.delete).toHaveBeenCalledTimes(2);
		expect(API.delete).toHaveBeenLastCalledWith("/room/movie-night", {
			params: { permanent: true },
		});
		expect(wrapper.find('[data-cy="rooms-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="delete-room-error"]').exists()).toBe(false);
	});

	it("sends only one permanent deletion while the first request is pending", async () => {
		API.get.mockResolvedValueOnce({
			data: { success: true, data: [room(), room({ name: "another-night" })] },
		});
		let finishDelete!: (response: { data: { success: true } }) => void;
		API.delete.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					finishDelete = resolve;
				}),
		);
		const { wrapper } = mountOwnedRooms();
		await flushPromises();
		await wrapper.findAll('[data-cy="delete-room"]')[0].trigger("click");
		await flushPromises();

		const confirm = wrapper.get('[data-cy="confirm-delete-room"]');
		await Promise.all([confirm.trigger("click"), confirm.trigger("click")]);

		expect(API.delete).toHaveBeenCalledTimes(1);
		expect(confirm.attributes("disabled")).toBeDefined();
		expect(wrapper.findAll('[data-cy="owned-room-entry"]')).toHaveLength(2);

		finishDelete({ data: { success: true } });
		await flushPromises();

		expect(wrapper.findAll('[data-cy="owned-room-entry"]')).toHaveLength(1);
		expect(wrapper.get('[data-cy="owned-room-entry"]').attributes("href")).toBe(
			"/room/another-night",
		);
	});
});
