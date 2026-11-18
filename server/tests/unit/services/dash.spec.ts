import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import DashVideoAdapter from "../../../services/dash.js";
import { UnsupportedVideoType } from "../../../exceptions.js";

vi.mock("axios");

const url = "https://example.com/video.mpd";

describe("DashVideoAdapter", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	function manifest(xml: string) {
		vi.mocked(axios.get).mockResolvedValue({ data: xml, headers: {} });
		return new DashVideoAdapter().fetchVideoInfo(url);
	}

	it("fetches a real XML MPD and parses its duration", async () => {
		const video = await manifest('<MPD mediaPresentationDuration="PT1H2M3S"/>');
		expect(video).toMatchObject({ service: "dash", id: url, length: 3723, dash_url: url });
		expect(axios.get).toHaveBeenCalledWith(
			url,
			expect.objectContaining({ maxRedirects: 0, responseType: "text" }),
		);
	});

	it.each([
		'<MPD profiles="isoff-live"/>',
		'<MPD type="dynamic" mediaPresentationDuration="PT60S"/>',
	])("keeps live XML out of the VOD clock: %s", async xml => {
		await expect(manifest(xml)).rejects.toBeInstanceOf(UnsupportedVideoType);
	});

	it("extracts the ProgramInformation title with XML entity decoding", async () => {
		const video = await manifest(
			'<MPD mediaPresentationDuration="PT3S"><ProgramInformation><Title>foo &amp; bar</Title></ProgramInformation></MPD>',
		);
		expect(video.title).toBe("foo & bar");
	});

	it("extracts a representation title when ProgramInformation is absent", async () => {
		const video = await manifest(
			'<MPD mediaPresentationDuration="PT3S"><Period><AdaptationSet><Representation><Title>foo</Title></Representation></AdaptationSet></Period></MPD>',
		);
		expect(video.title).toBe("foo");
	});

	it.each([
		"P",
		"PT0S",
		"prefixPT60S",
		"PTNaNS",
	])("rejects an invalid VOD duration: %s", async duration => {
		await expect(manifest(`<MPD mediaPresentationDuration="${duration}"/>`)).rejects.toThrow();
	});
});
