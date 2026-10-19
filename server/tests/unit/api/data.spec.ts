import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { main } from "../../../app.js";
import InfoExtract, { AddPreview } from "../../../infoextractor.js";
import tokens from "../../../auth/tokens.js";
import { mediaFileStatus } from "../../../services/media-access.js";

vi.mock("../../../services/media-access.js", async importOriginal => {
	const actual = await importOriginal<typeof import("../../../services/media-access.js")>();
	return { ...actual, mediaFileStatus: vi.fn() };
});

const JSON_CONTENT_TYPE_REGEX = /json/;
const DIRECT_VIDEO = {
	service: "direct" as const,
	id: "https://example.com/video/110.mp4",
	title: "110",
};
const mockStatus = mediaFileStatus as unknown as ReturnType<typeof vi.fn>;

describe("Data API", () => {
	let app;
	let getSessionInfoSpy;
	let validateSpy;

	beforeAll(async () => {
		getSessionInfoSpy = vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "test",
		});
		validateSpy = vi.spyOn(tokens, "validate").mockResolvedValue(true);
		app = (await main()).app;
	});

	afterAll(() => {
		getSessionInfoSpy.mockRestore();
		validateSpy.mockRestore();
	});

	beforeEach(() => {
		mockStatus.mockReset();
	});

	it("refuses a direct preview whose file is definitely gone", async () => {
		const resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([DIRECT_VIDEO], 0));
		mockStatus.mockResolvedValue(404);

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: DIRECT_VIDEO.id })
			.expect(404)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error.name).toBe("VideoNotFoundException");
			});

		resolveQuerySpy.mockRestore();
	});

	it("keeps a direct preview whose host refuses the check", async () => {
		const resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([DIRECT_VIDEO], 0));
		mockStatus.mockResolvedValue(403);

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: DIRECT_VIDEO.id })
			.expect(200)
			.then(resp => {
				expect(resp.body.success).toBe(true);
				expect(resp.body.result).toHaveLength(1);
			});

		resolveQuerySpy.mockRestore();
	});

	it("only accepts a confirmed file when the probe asks for verification", async () => {
		const resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([DIRECT_VIDEO], 0));
		mockStatus.mockResolvedValue(403);

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: DIRECT_VIDEO.id, verify: "1" })
			.expect(404)
			.then(resp => {
				expect(resp.body.success).toBe(false);
			});

		mockStatus.mockResolvedValue(200);
		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: DIRECT_VIDEO.id, verify: "1" })
			.expect(200)
			.then(resp => {
				expect(resp.body.success).toBe(true);
			});

		resolveQuerySpy.mockRestore();
	});

	it("GET /data/previewAdd", async () => {
		let resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([], 0));

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(200)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(true);
				expect(resp.body.result).toHaveLength(0);
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
		resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockRejectedValue({ name: "UnsupportedServiceException", message: "error message" });

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(400)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error).toBeDefined();
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
		resolveQuerySpy = vi.spyOn(InfoExtract, "resolveVideoQuery").mockRejectedValue({
			name: "InvalidAddPreviewInputException",
			message: "error message",
		});

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(400)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error).toBeDefined();
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
		resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockRejectedValue({ name: "OutOfQuotaException", message: "error message" });

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(400)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error).toBeDefined();
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
	});

	it("GET /data/previewAdd with adapter parameter", async () => {
		const resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([], 0));

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "https://example.com/video", adapter: "direct" })
			.expect(200)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(true);
				expect(resolveQuerySpy).toHaveBeenCalledWith(
					"https://example.com/video",
					expect.any(String),
					"direct",
				);
			});

		resolveQuerySpy.mockRestore();
	});
});
