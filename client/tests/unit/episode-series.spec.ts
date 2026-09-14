import { describe, expect, it } from "vitest";
import {
	episodeTokenChoices,
	findNumberTokens,
	isEpisodeLike,
	seriesKey,
	shiftToken,
} from "@/util/episode-series";

describe("same-series probing", () => {
	it("finds the numbers in the path only, ignoring the host, port and query", () => {
		const tokens = findNumberTokens(
			"https://giri.example.top:8443/zijian/2026/07/cht/ShowCHT/1/playlist.m3u8?token=99",
		);
		expect(tokens.map(t => t.digits)).toEqual(["2026", "07", "1"]);
	});

	it("never treats a year or a resolution as an episode number", () => {
		const [year, month, episode] = findNumberTokens("https://h/a/2026/07/1/p.m3u8");
		expect(isEpisodeLike(year)).toBe(false);
		expect(isEpisodeLike(month)).toBe(true);
		expect(isEpisodeLike(episode)).toBe(true);
		expect(isEpisodeLike({ value: 1080, digits: "1080", start: 0, end: 4 })).toBe(false);
	});

	it("offers the last episode number first, then the one before it", () => {
		const choices = episodeTokenChoices("https://h/zijian/2026/07/ShowCHT/1/playlist.m3u8");
		expect(choices.map(t => t.digits)).toEqual(["1", "07"]);

		const single = episodeTokenChoices("https://h/anime/ep01.mp4");
		expect(single.map(t => t.digits)).toEqual(["01"]);
	});

	it("bumps a number while keeping its zero padding", () => {
		const [token] = episodeTokenChoices("https://h/anime/ep01.mp4");
		expect(shiftToken("https://h/anime/ep01.mp4", token, 1)).toBe("https://h/anime/ep02.mp4");
		expect(shiftToken("https://h/anime/ep01.mp4", token, 3)).toBe("https://h/anime/ep04.mp4");

		const [folder] = episodeTokenChoices("https://h/zijian/2026/07/ShowCHT/1/playlist.m3u8");
		expect(shiftToken("https://h/zijian/2026/07/ShowCHT/1/playlist.m3u8", folder, 2)).toBe(
			"https://h/zijian/2026/07/ShowCHT/3/playlist.m3u8",
		);
	});

	it("keys the same series together and different ones apart", () => {
		const a = seriesKey("https://h/anime/ep01.mp4");
		expect(seriesKey("https://h/anime/ep12.mp4")).toBe(a);
		expect(seriesKey("https://h/other/ep01.mp4")).not.toBe(a);
		expect(seriesKey("https://h/anime/one.mp4")).toBe("https://h/anime/one.mp4");
	});
});
