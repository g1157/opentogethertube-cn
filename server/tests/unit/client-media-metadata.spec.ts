import { describe, expect, it } from "vitest";
import { MAX_CLIENT_METADATA_LENGTH_SECONDS } from "ott-common/constants.js";
import type { VideoAdd } from "ott-common/models/video.js";
import { BadApiArgumentException } from "../../exceptions.js";
import { videoFromClientMetadata } from "../../client-media-metadata.js";

function add(overrides: Partial<VideoAdd> = {}): VideoAdd {
	return {
		service: "direct",
		id: "https://media.example.invalid/movie.mp4?token=abc",
		metadata: {
			title: "A movie",
			mime: "video/mp4",
			length: 125.2,
			description: "From Emby",
			thumbnail: "https://media.example.invalid/poster.jpg",
			width: 1920,
			height: 1080,
			cors: true,
			mediaAccess: { referrerPolicy: "no-referrer", requiresOriginReferer: false },
		},
		...overrides,
	};
}

describe("client-supplied media metadata", () => {
	it("returns no video when the request has no metadata", () => {
		const { metadata: _metadata, ...plain } = add();
		expect(videoFromClientMetadata(plain)).toBeUndefined();
	});

	it("builds a queueable video without a probe", () => {
		const video = videoFromClientMetadata(add());
		expect(video).toEqual({
			service: "direct",
			id: "https://media.example.invalid/movie.mp4?token=abc",
			title: "A movie",
			description: "From Emby",
			mime: "video/mp4",
			length: 126,
			thumbnail: "https://media.example.invalid/poster.jpg",
			width: 1920,
			height: 1080,
			cors: true,
			mediaAccess: { referrerPolicy: "no-referrer", requiresOriginReferer: false },
		});
	});

	it("keeps HLS and DASH sources on their own services", () => {
		const hls = videoFromClientMetadata({
			...add(),
			service: "hls",
			id: "https://media.example.invalid/master.m3u8",
			metadata: { title: "Live", mime: "application/x-mpegURL", isLive: true, length: 60 },
		});
		expect(hls).toMatchObject({ service: "hls", isLive: true });
		expect(hls?.length).toBeUndefined();
		const dash = videoFromClientMetadata({
			...add(),
			service: "dash",
			id: "https://media.example.invalid/manifest.mpd",
			metadata: { title: "Dash", mime: "application/dash+xml" },
		});
		expect(dash).toMatchObject({ service: "dash", mime: "application/dash+xml" });
	});

	it.each([
		"youtube",
		"vimeo",
		"bilibili",
	] as const)("refuses metadata on the %s service", service => {
		expect(() =>
			videoFromClientMetadata({
				...add(),
				service,
				id: "canonical-id",
			}),
		).toThrow(BadApiArgumentException);
	});

	it.each([
		"file:///C:/private/movie.mp4",
		"javascript:alert(1)",
		"data:video/mp4;base64,AAAA",
		"/relative/path.mp4",
		"https://user:pass@media.example.invalid/movie.mp4",
	])("refuses the unsafe media URL %s", id => {
		expect(() => videoFromClientMetadata(add({ id }))).toThrow(BadApiArgumentException);
	});

	it("refuses unsupported or lying MIME types", () => {
		for (const mime of ["video/x-matroska", "text/html", "application/octet-stream", ""]) {
			expect(() =>
				videoFromClientMetadata({
					...add(),
					metadata: { title: "Movie", mime },
				}),
			).toThrow(BadApiArgumentException);
		}
	});

	it("bounds titles, descriptions, thumbnails and duration", () => {
		const base = add();
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: { ...base.metadata!, title: "" },
			}),
		).toThrow(BadApiArgumentException);
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: { ...base.metadata!, title: "x".repeat(201) },
			}),
		).toThrow(BadApiArgumentException);
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: { ...base.metadata!, title: "bad\u0000title" },
			}),
		).toThrow(BadApiArgumentException);
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: { ...base.metadata!, description: "x".repeat(2001) },
			}),
		).toThrow(BadApiArgumentException);
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: {
					...base.metadata!,
					thumbnail: "https://example.invalid/" + "x".repeat(2048),
				},
			}),
		).toThrow(BadApiArgumentException);
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: { ...base.metadata!, length: MAX_CLIENT_METADATA_LENGTH_SECONDS + 1 },
			}),
		).toThrow(BadApiArgumentException);
		expect(() =>
			videoFromClientMetadata({
				...base,
				metadata: { ...base.metadata!, width: 0 },
			}),
		).toThrow(BadApiArgumentException);
	});

	it("drops unknown media-access flags instead of trusting them", () => {
		const video = videoFromClientMetadata({
			...add(),
			metadata: {
				title: "Movie",
				mime: "video/mp4",
				mediaAccess: {
					referrerPolicy: "no-referrer",
					// @ts-expect-error a wire request can carry anything
					unknownFlag: true,
				},
			},
		});
		expect(video?.mediaAccess).toEqual({ referrerPolicy: "no-referrer" });
	});
});
