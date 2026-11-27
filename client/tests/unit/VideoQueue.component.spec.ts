import { describe, expect, it } from "vitest";
import { QueueMode } from "ott-common/models/types";
import type { QueueItem } from "ott-common/models/video";
import VideoQueue from "@/components/VideoQueue.vue";
import { flush, mountComponent } from "./component-test-utils";

function queued(id: string, title: string): QueueItem {
	return { service: "youtube", id, title, description: "", length: 60 };
}

function mountQueue(queue: QueueItem[] = [], queueMode: QueueMode = QueueMode.Manual) {
	const result = mountComponent(VideoQueue);
	result.store.state.room.name = "foo";
	result.store.state.room.queue = queue;
	result.store.commit("room/SYNC", { queueMode });
	return result;
}

describe("VideoQueue component", () => {
	it("exposes the queue as a labelled list with one list item per video", async () => {
		const { wrapper } = mountQueue([queued("1", "First"), queued("2", "Second")]);
		await flush();

		const list = wrapper.get('[role="list"]');
		expect(list.attributes("aria-label")).toBeTruthy();

		const items = wrapper.findAll('[role="listitem"]');
		expect(items).toHaveLength(2);
		// Screen readers only report "第 M 项，共 N 项" when the items are owned by the list.
		for (const item of items) {
			expect(item.element.parentElement).toBe(list.element);
		}
		expect(items[0].text()).toContain("First");
		expect(items[1].text()).toContain("Second");
	});

	it("keeps the list and its name when the queue is empty", async () => {
		const { wrapper } = mountQueue([]);
		await flush();

		expect(wrapper.get('[role="list"]').attributes("aria-label")).toBeTruthy();
		expect(wrapper.findAll('[role="listitem"]')).toHaveLength(0);
	});
});
