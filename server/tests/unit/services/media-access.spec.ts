import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appOriginFromHostname, probeMediaAccess } from "../../../services/media-access.js";

vi.mock("axios");
// The SSRF guard resolves DNS; the probes must not depend on real hosts in tests.
vi.mock("../../../ffprobe.js", () => ({
	assertPublicMediaUrl: vi.fn().mockResolvedValue(undefined),
}));

const APP_ORIGIN = "https://ott.example.org";
const SEGMENT = "https://cdn.example.org/seg-1.ts";

function response(status: number, headers: Record<string, string> = {}) {
	return { status, headers, data: { destroy: vi.fn() } };
}

describe("media access probe", () => {
	let mockGet: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGet = axios.get as unknown as ReturnType<typeof vi.fn>;
		mockGet.mockReset();
	});

	it("leaves a source alone when the browser's own Referer already works", async () => {
		mockGet.mockResolvedValueOnce(response(206, { "access-control-allow-origin": "*" }));

		const result = await probeMediaAccess(SEGMENT, APP_ORIGIN);

		expect(result).toEqual({ cors: true });
		expect(mockGet).toHaveBeenCalledOnce();
		expect(mockGet.mock.calls[0][1].headers).toMatchObject({ Referer: `${APP_ORIGIN}/` });
	});

	it("asks without a Referer once the host refuses this origin", async () => {
		mockGet.mockResolvedValueOnce(response(403));
		mockGet.mockResolvedValueOnce(response(200, { "access-control-allow-origin": "*" }));

		const result = await probeMediaAccess(SEGMENT, APP_ORIGIN);

		expect(result).toEqual({ cors: true, mediaAccess: { referrerPolicy: "no-referrer" } });
		expect(mockGet).toHaveBeenCalledTimes(2);
		expect(mockGet.mock.calls[1][1].headers).not.toHaveProperty("Referer");
	});

	it("reports a host that refuses every policy this app can send", async () => {
		mockGet.mockResolvedValueOnce(response(403));
		mockGet.mockResolvedValueOnce(response(403));

		const result = await probeMediaAccess(SEGMENT, APP_ORIGIN);

		expect(result.mediaAccess).toEqual({ requiresOriginReferer: true });
	});

	it("does not blame a Referer policy for a missing file", async () => {
		mockGet.mockResolvedValueOnce(response(404));
		mockGet.mockResolvedValueOnce(response(404));

		const result = await probeMediaAccess(SEGMENT, APP_ORIGIN);

		expect(result).toEqual({});
	});

	it("stays silent when the network fails, so nothing changes on a guess", async () => {
		mockGet.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

		const result = await probeMediaAccess(SEGMENT, APP_ORIGIN);

		expect(result).toEqual({});
	});

	it("notes a response whose type does not match the media it carries", async () => {
		mockGet.mockResolvedValueOnce(response(403));
		mockGet.mockResolvedValueOnce(response(200, { "content-type": "image/png" }));

		const result = await probeMediaAccess(SEGMENT, APP_ORIGIN);

		expect(result.mediaAccess).toEqual({
			referrerPolicy: "no-referrer",
			containerMismatch: true,
		});
	});
});

describe("app origin", () => {
	it("builds the origin a page of this app would send as Referer", () => {
		expect(appOriginFromHostname("ott.example.org")).toBe("https://ott.example.org");
	});
});
