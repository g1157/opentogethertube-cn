import { describe, expect, it } from "vitest";
import { VideoQueue } from "../../videoqueue.js";
import type { QueueItem } from "ott-common/models/video.js";

function item(id: string): QueueItem {
	return { service: "direct", id, length: 10 };
}

describe("VideoQueue bounds under concurrent mutations", () => {
	it("does not insert at an index that a queued eviction has just removed", async () => {
		const queue = new VideoQueue([item("a"), item("b"), item("c")]);
		// The eviction takes the lock first; the insert's bounds check runs before it.
		const eviction = queue.evict(item("a"));
		const insertion = queue.insert(item("d"), 3);

		await eviction;

		await expect(insertion).rejects.toThrow("Index out of bounds");
		expect(queue.items.map(entry => entry.id)).toEqual(["b", "c"]);
	});

	it("does not move to an index that no longer exists after a queued eviction", async () => {
		const queue = new VideoQueue([item("a"), item("b"), item("c")]);
		const eviction = queue.evict(item("a"));
		const move = queue.move(1, 2);

		await eviction;

		await expect(move).rejects.toThrow("'toIdx' out of bounds");
		expect(queue.items.map(entry => entry.id)).toEqual(["b", "c"]);
	});
});
