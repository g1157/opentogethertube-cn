import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isPictureInPictureSupported,
	pictureInPictureState,
	togglePictureInPicture,
	whenMetadataReady,
	type PictureInPictureDocument,
} from "@/util/picture-in-picture";

/** A document that answers the three things the API checks, without jsdom's Document. */
function fakeDocument(overrides: Partial<PictureInPictureDocument> = {}) {
	const doc = {
		pictureInPictureElement: null as Element | null,
		pictureInPictureEnabled: true,
		exitPictureInPicture: vi.fn(async () => {
			doc.pictureInPictureElement = null;
		}),
		...overrides,
	};
	return doc as PictureInPictureDocument & typeof doc;
}

function fakeVideo(options: { readyState?: number; disable?: boolean } = {}) {
	const video = document.createElement("video");
	Object.defineProperties(video, {
		readyState: { value: options.readyState ?? 4, configurable: true },
		disablePictureInPicture: { value: options.disable ?? false, configurable: true },
	});
	const request = vi.fn(async () => {
		// jsdom has no PiP window; the call itself is what these tests cover.
	});
	(video as unknown as { requestPictureInPicture: unknown }).requestPictureInPicture = request;
	return { video, request };
}

describe("picture-in-picture availability", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});


	it("hides the button where the interface does not exist (Firefox before 153)", () => {
		expect(pictureInPictureState({} as PictureInPictureDocument)).toBe("unsupported");
		expect(isPictureInPictureSupported({} as PictureInPictureDocument)).toBe(false);
	});

	it("reports a switched-off API instead of offering a button that always fails", () => {
		// Firefox answers false here when the pref is off; Chrome when a policy disables it.
		const doc = fakeDocument({ pictureInPictureEnabled: false });
		expect(pictureInPictureState(doc)).toBe("disabled");
		expect(isPictureInPictureSupported(doc)).toBe(false);
	});

	it("is supported when the interface exists and is enabled", () => {
		expect(pictureInPictureState(fakeDocument())).toBe("ready");
	});
});

describe("whenMetadataReady", () => {
	it("resolves immediately once there is metadata", async () => {
		const { video } = fakeVideo({ readyState: 4 });
		await expect(whenMetadataReady(video, 10)).resolves.toBe(true);
	});

	it("waits for the metadata a Firefox request needs, and gives up on its own", async () => {
		const { video } = fakeVideo({ readyState: 0 });
		await expect(whenMetadataReady(video, 10)).resolves.toBe(false);
	});

	it("resumes as soon as metadata arrives", async () => {
		const { video } = fakeVideo({ readyState: 0 });
		const pending = whenMetadataReady(video, 1000);
		Object.defineProperty(video, "readyState", { value: 1, configurable: true });
		video.dispatchEvent(new Event("loadedmetadata"));
		await expect(pending).resolves.toBe(true);
	});
});

describe("togglePictureInPicture", () => {
	it("enters PiP on the player's element", async () => {
		const doc = fakeDocument();
		const { video, request } = fakeVideo();
		await expect(togglePictureInPicture(video, doc)).resolves.toBe("entered");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("leaves when a PiP element is already showing", async () => {
		const { video } = fakeVideo();
		const doc = fakeDocument({ pictureInPictureElement: video });
		await expect(togglePictureInPicture(video, doc)).resolves.toBe("left");
		expect(doc.exitPictureInPicture).toHaveBeenCalledTimes(1);
	});

	it("refuses before metadata instead of throwing, which is what Firefox used to do", async () => {
		const doc = fakeDocument();
		const { video, request } = fakeVideo({ readyState: 0 });
		await expect(togglePictureInPicture(video, doc, { metadataTimeoutMs: 10 })).resolves.toBe(
			"rejected",
		);
		expect(request).not.toHaveBeenCalled();
	});

	it("reports the browser's refusal rather than rejecting the click handler", async () => {
		const doc = fakeDocument();
		const { video } = fakeVideo();
		vi.spyOn(video, "requestPictureInPicture").mockImplementation(async () => {
			throw new DOMException("The operation is not allowed.", "NotAllowedError");
		});
		await expect(togglePictureInPicture(video, doc)).resolves.toBe("rejected");
	});

	it("names the two cases the button cannot start at all", async () => {
		await expect(togglePictureInPicture(null, fakeDocument())).resolves.toBe("no-video");
		const disabled = fakeDocument({ pictureInPictureEnabled: false });
		await expect(togglePictureInPicture(fakeVideo().video, disabled)).resolves.toBe("disabled");
		const { video } = fakeVideo({ disable: true });
		await expect(togglePictureInPicture(video, fakeDocument())).resolves.toBe("disabled");
	});
});

describe("the room while a PiP window is up", () => {
	it("tracks the document's element from the non-bubbling events", async () => {
		const { pictureInPictureActive } = await import("@/util/picture-in-picture");
		const video = document.createElement("video");
		document.body.appendChild(video);
		Object.defineProperty(document, "pictureInPictureElement", {
			value: video,
			configurable: true,
		});
		pictureInPictureActive.value = false;
		video.dispatchEvent(new Event("enterpictureinpicture"));
		expect(pictureInPictureActive.value).toBe(true);

		Object.defineProperty(document, "pictureInPictureElement", {
			value: null,
			configurable: true,
		});
		video.dispatchEvent(new Event("leavepictureinpicture"));
		expect(pictureInPictureActive.value).toBe(false);
		video.remove();
	});
});
