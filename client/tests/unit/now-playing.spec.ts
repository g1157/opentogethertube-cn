import { describe, expect, it } from "vitest";
import { nowPlayingDetails } from "@/util/now-playing";

describe("now-playing episode labels", () => {
	it.each([
		["节目 第03集", "03", null],
		["节目 第十二集", "十二", null],
		["Show.S02E03.1080p", "3", "2"],
		["Show EP003", "3", null],
	])("recognizes an explicit episode in %s", (title, episode, season) => {
		expect(nowPlayingDetails({ service: "direct", id: "file.mp4", title })).toEqual({
			title,
			episode,
			season,
		});
	});
	it("uses a numbered filename while preserving the readable title", () => {
		expect(
			nowPlayingDetails({
				service: "direct",
				id: "https://example.com/show/03.mp4?token=secret",
				title: "某剧",
			}),
		).toEqual({ title: "某剧", episode: "3", season: null });
	});
	it("does not expose a signed URL when the title is missing or is a raw URL", () => {
		const url = "https://example.com/show/04.mp4?token=secret#private";
		expect(nowPlayingDetails({ service: "direct", id: url }).title).toBe("04.mp4");
		expect(nowPlayingDetails({ service: "direct", id: url, title: url }).title).toBe("04.mp4");
	});
	it("does not invent episode numbers from years, resolutions or opaque IDs", () => {
		expect(
			nowPlayingDetails({ service: "direct", id: "movie.2025.1080p.mp4" }).episode,
		).toBeNull();
		expect(nowPlayingDetails({ service: "youtube", id: "abc123456" }).episode).toBeNull();
	});
});
