import { describe, expect, it } from "vitest";
import dayjs from "dayjs";
import { filterVideoInfo } from "../../storage/cachedvideo.js";
import type { CachedVideo } from "../../models/cachedvideo.js";

function cached(overrides: Partial<CachedVideo>): CachedVideo {
	const now = dayjs();
	return {
		service: "youtube",
		serviceId: "dQw4w9WgXcQ",
		title: "A cached title",
		description: "A cached description",
		thumbnail: "https://example.com/thumb.jpg",
		length: 212,
		mime: "video/mp4",
		createdAt: now.subtract(1, "day").toDate(),
		updatedAt: now.subtract(1, "day").toDate(),
		...overrides,
	} as CachedVideo;
}

describe("cached video freshness", () => {
	it("keeps information refreshed within the last day", () => {
		const video = filterVideoInfo(cached({}));
		expect(video.title).toBe("A cached title");
		expect(video.length).toBe(212);
	});

	it("drops stale information from an old record", () => {
		const video = filterVideoInfo(
			cached({
				createdAt: dayjs().subtract(100, "day").toDate(),
				updatedAt: dayjs().subtract(40, "day").toDate(),
			}),
		);
		expect(video.title).toBeUndefined();
		expect(video.description).toBeUndefined();
		expect(video.thumbnail).toBeUndefined();
		expect(video.length).toBeUndefined();
		// The mime type cannot change, so it survives an expired record.
		expect(video.mime).toBe("video/mp4");
	});

	it("allows thirty days for a record older than a week", () => {
		const video = filterVideoInfo(
			cached({
				createdAt: dayjs().subtract(60, "day").toDate(),
				updatedAt: dayjs().subtract(20, "day").toDate(),
			}),
		);
		expect(video.title).toBe("A cached title");
	});

	it("only allows seven days while the cache entry is still new", () => {
		const recent = filterVideoInfo(
			cached({
				createdAt: dayjs().subtract(2, "day").toDate(),
				updatedAt: dayjs().subtract(6, "day").toDate(),
			}),
		);
		expect(recent.title).toBe("A cached title");
		const expired = filterVideoInfo(
			cached({
				createdAt: dayjs().subtract(2, "day").toDate(),
				updatedAt: dayjs().subtract(9, "day").toDate(),
			}),
		);
		expect(expired.title).toBeUndefined();
	});
});
