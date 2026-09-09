import { describe, it, expect } from "vitest";
import DirectVideoAdapter from "../../../services/direct.js";
import { FfprobeStrategy } from "../../../ffprobe.js";
import fs from "node:fs";
import { isSupportedMimeType } from "../../../mime.js";

const FIXTURE_DIRECTORY = "./tests/unit/fixtures/services/direct";

class FfprobeFixtures extends FfprobeStrategy {
	async getFileInfo(uri: string): Promise<any> {
		const url = new URL(uri);
		const audioStream = {
			// eslint-disable-next-line camelcase
			codec_type: "audio",
			duration: 100,
		};

		return {
			"/test.mp4": {
				streams: [
					{
						// eslint-disable-next-line camelcase
						codec_type: "video",
						duration: 100,
					},
				],
			},
			"/foo.mp4": this.getFixture("ffprobe-output-has-title.json"),
			"/audio.mp4": { streams: [audioStream] },
			"/audio.webm": { streams: [audioStream] },
			"/cover.mp4": {
				streams: [
					{
						// eslint-disable-next-line camelcase
						codec_type: "video",
						// eslint-disable-next-line camelcase
						disposition: { attached_pic: 1 },
						duration: 1,
					},
					audioStream,
				],
			},
		}[url.pathname];
	}

	getFixture(file: string) {
		const path = `${FIXTURE_DIRECTORY}/${file}`;
		if (fs.existsSync(path)) {
			const content = fs.readFileSync(path, "utf8");
			return JSON.parse(content);
		}
		throw new Error("fixture not found");
	}
}

describe("Direct", () => {
	describe("canHandleURL", () => {
		const supportedExtensions = [
			"mp4",
			"mp4v",
			"mpg4",
			"webm",
			"flv",
			"mkv",
			"avi",
			"wmv",
			"qt",
			"mov",
			"ogv",
			"m4v",
			"h264",
			"ogg",
			"mp3",
		];

		const adapter = new DirectVideoAdapter();

		it.each(supportedExtensions)("Accepts %s links", extension => {
			const url = `https://example.com/test.${extension}`;
			expect(adapter.canHandleURL(url)).toBe(true);
		});

		const unsupportedExtensions = [
			"jpg",
			"jpeg",
			"png",
			"gif",
			"bmp",
			"tiff",
			"tif",
			"psd",
			"pdf",
			"doc",
			"docx",
			"xls",
			"xlsx",
			"ppt",
			"pptx",
			"zip",
			"rar",
			"7z",
			"tar",
			"gz",
			"mp3v",
			"wav",
		];

		it.each(unsupportedExtensions)("Rejects %s links", extension => {
			const url = `https://example.com/test.${extension}`;
			expect(adapter.canHandleURL(url)).toBe(false);
		});
	});

	describe("isCollectionURL", () => {
		const adapter = new DirectVideoAdapter();

		it("Always returns false because collections aren't supported", () => {
			const url = "https://example.com/test.mp4";
			expect(adapter.isCollectionURL(url)).toBe(false);
		});
	});

	describe("getVideoId", () => {
		const adapter = new DirectVideoAdapter();

		it("Returns the link itself as the ID", () => {
			const url = "https://example.com/test.mp4";
			expect(adapter.getVideoId(url)).toBe(url);
		});
	});

	describe("fetchVideoInfo", () => {
		const adapter = new DirectVideoAdapter();
		adapter.ffprobe = new FfprobeFixtures();

		it("Returns a promise", async () => {
			const url = "https://example.com/test.mp4";
			expect(adapter.fetchVideoInfo(url)).toBeInstanceOf(Promise);
		});

		it("Returns a video", async () => {
			const url = "https://example.com/test.mp4";
			const video = await adapter.fetchVideoInfo(url);
			expect(video).toMatchObject({
				id: url,
				length: 100,
			});
		});

		it("Returns a video with the title from the metadata", async () => {
			const url = "https://example.com/foo.mp4";
			const video = await adapter.fetchVideoInfo(url);
			expect(video).toMatchObject({
				id: url,
				title: "Foo: The Movie",
				length: 69420,
				mime: "video/mp4",
			});
		});

		it.each([
			["mp4", "audio/mp4"],
			["webm", "audio/webm"],
		])("Uses audio metadata for an audio-only %s container", async (extension, mime) => {
			const video = await adapter.fetchVideoInfo(`https://example.com/audio.${extension}`);
			expect(video).toMatchObject({ mime, length: 100 });
			expect(isSupportedMimeType(video.mime!)).toBe(true);
		});

		it("Uses the audio duration and MIME when the only video stream is album artwork", async () => {
			const video = await adapter.fetchVideoInfo("https://example.com/cover.mp4");
			expect(video).toMatchObject({ mime: "audio/mp4", length: 100 });
		});
	});
});
