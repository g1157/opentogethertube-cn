import { describe, expect, it, vi } from "vitest";
import {
	episodeTokenChoices,
	findNumberTokens,
	isEpisodeLike,
	probeSameSeries,
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

const SEASON_FOLDER = /\/show\/0[24]\/ep11\.mp4$/;

describe("probeSameSeries", () => {
	// The probe preserves the digit width of the token it bumps ("11" => "09", not "9").
	const urls = (numbers: number[]) =>
		new Set(numbers.map(n => `https://h/anime/${String(n).padStart(2, "0")}.mp4`));
	const lookupFor = (available: Set<string>) =>
		vi.fn(async (url: string) => (available.has(url) ? [{ id: url }] : null));

	it("walks both directions and returns the season in order", async () => {
		const lookup = lookupFor(urls(Array.from({ length: 26 }, (_, i) => i + 1)));
		const found = await probeSameSeries("https://h/anime/11.mp4", lookup);

		expect(found.map(v => v.id)).toEqual(
			[
				...Array.from({ length: 10 }, (_, i) => i + 1),
				...Array.from({ length: 15 }, (_, i) => i + 12),
			].map(n => `https://h/anime/${String(n).padStart(2, "0")}.mp4`),
		);
		// 15 forward hits plus two misses, then 10 backward hits down to episode 1.
		expect(lookup).toHaveBeenCalledTimes(27);
	});

	it("stops at the edges of what the folder actually holds", async () => {
		const lookup = lookupFor(urls([11, 12, 13, 14, 15]));
		const found = await probeSameSeries("https://h/anime/11.mp4", lookup);

		expect(found.map(v => v.id)).toEqual([12, 13, 14, 15].map(n => `https://h/anime/${n}.mp4`));
		expect(lookup).toHaveBeenCalledTimes(8);
	});

	it("caps the request count with a budget", async () => {
		const lookup = lookupFor(urls(Array.from({ length: 26 }, (_, i) => i + 1)));
		const found = await probeSameSeries("https://h/anime/11.mp4", lookup, { budget: 5 });

		expect(lookup).toHaveBeenCalledTimes(5);
		expect(found).toHaveLength(5);
	});

	it("stops once the probe has been superseded", async () => {
		let calls = 0;
		const lookup = vi.fn(async (url: string) => {
			calls++;
			return [{ id: url }];
		});
		const found = await probeSameSeries("https://h/anime/11.mp4", lookup, {
			isAborted: () => calls >= 1,
		});

		expect(found).toEqual([]);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("falls back to the earlier number when the last one yields nothing", async () => {
		const lookup = vi.fn(async (candidate: string) =>
			SEASON_FOLDER.test(candidate) ? [{ id: candidate }] : null,
		);
		const found = await probeSameSeries("https://h/show/03/ep11.mp4", lookup);

		expect(found.map(v => v.id)).toEqual([
			"https://h/show/02/ep11.mp4",
			"https://h/show/04/ep11.mp4",
		]);
	});
});
