import { describe, expect, it } from "vitest";
import { girigiriProvider } from "@/util/danmaku/girigiri";
import { findDanmakuProvider } from "@/util/danmaku/provider";

const resolve = (url: string) => girigiriProvider.resolve(url);

describe("girigiri danmaku provider", () => {
	it("maps direct files to the mirrored danmu host", () => {
		expect(
			resolve("https://ana.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/01.mp4"),
		).toBe("https://danmu.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/01.xml");
	});

	it("serves CHT direct files from their CHS danmaku sibling", () => {
		expect(
			resolve(
				"https://ana.girigirilove.com/zijian/oldanime/2025/0121/NukitashitheAnimationCHT/01.mp4",
			),
		).toBe(
			"https://danmu.girigirilove.com/zijian/oldanime/2025/0121/NukitashitheAnimationCHS/01.xml",
		);
	});

	it("places HLS tracks next to the episode folder on the same host", () => {
		expect(
			resolve(
				"https://akua.girigirilove.com/zijian/oldanime/2026/04/cht/ReZeroS4CHT/01/playlist.m3u8",
			),
		).toBe("https://akua.girigirilove.com/zijian/oldanime/2026/04/cht/ReZeroS4CHT/01.xml");
		// Movies have no episode folder: the pack folder itself becomes the track name.
		expect(
			resolve(
				"https://akua.girigirilove.com/zijian/anime/2025/01/05/PerfectBlue/playlist.m3u8",
			),
		).toBe("https://akua.girigirilove.com/zijian/anime/2025/01/05/PerfectBlue.xml");
	});

	it("rejects URLs that are not girigiri video files", () => {
		expect(resolve("https://example.com/a/b.mp4")).toBeNull();
		expect(resolve("https://fakegirigirilove.com/a.mp4")).toBeNull();
		expect(resolve("not a url")).toBeNull();
		expect(resolve("https://ana.girigirilove.com/a/b")).toBeNull();
	});

	it("is discovered through the provider registry", () => {
		expect(findDanmakuProvider("https://ana.girigirilove.com/a/b.mp4")).toEqual({
			provider: girigiriProvider,
			url: "https://danmu.girigirilove.com/a/b.xml",
		});
		expect(findDanmakuProvider("https://example.com/a/b.mp4")).toBeNull();
	});
});
