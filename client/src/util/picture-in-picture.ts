// Picture-in-Picture, with the browser differences the room actually meets.
//
// The button used to call `video.requestPictureInPicture()` and log the rejection, so every
// browser-specific refusal looked like a dead button. Firefox is the one that needs care: it
// only shipped the API in 153, it answers `NotSupportedError` when the feature is off through a
// user preference or a platform limitation, and it rejects a request at `HAVE_NOTHING` — no
// metadata yet, which is what a room that is still buffering looks like. Chrome is more
// forgiving on all three, which is why the button was written against it.
import { ref } from "vue";

/** Why a request could not start, for the notice the button shows. */
export type PictureInPictureFailure = "unsupported" | "disabled" | "no-video" | "rejected";

export type PictureInPictureOutcome = "entered" | "left" | PictureInPictureFailure;

export interface PictureInPictureDocument {
	pictureInPictureElement?: Element | null;
	pictureInPictureEnabled?: boolean;
	exitPictureInPicture?: () => Promise<void>;
}

/**
 * Whether this document can use the API at all. `pictureInPictureElement` says the interface
 * exists (Firefox before 153 does not even have the property, so the button stays hidden), and
 * `pictureInPictureEnabled` says it is allowed to run — Firefox answers false when the pref is
 * off, and Chrome when a platform policy disables it.
 */
export function pictureInPictureState(
	doc: PictureInPictureDocument = document as PictureInPictureDocument,
): "unsupported" | "disabled" | "ready" {
	if (!("pictureInPictureElement" in doc)) {
		return "unsupported";
	}
	if (doc.pictureInPictureEnabled === false) {
		return "disabled";
	}
	return "ready";
}

/** True when a request would be accepted right now, as far as the document can tell. */
export function isPictureInPictureSupported(
	doc: PictureInPictureDocument = document as PictureInPictureDocument,
): boolean {
	return pictureInPictureState(doc) === "ready";
}

/**
 * Resolves once the element carries metadata. A request at `HAVE_NOTHING` is an
 * `InvalidStateError` by spec, so a click on a room that is still buffering waits for the first
 * metadata instead of failing; the timeout keeps a video that never arrives from hanging the
 * button. Resolves false when it never arrives.
 */
export function whenMetadataReady(video: HTMLVideoElement, timeoutMs = 4000): Promise<boolean> {
	if (video.readyState >= video.HAVE_METADATA) {
		return Promise.resolve(true);
	}
	return new Promise<boolean>(resolve => {
		const clean = () => {
			clearTimeout(timer);
			video.removeEventListener("loadedmetadata", onMetadata);
		};
		const onMetadata = () => {
			clean();
			resolve(true);
		};
		const timer = setTimeout(() => {
			clean();
			resolve(false);
		}, timeoutMs);
		video.addEventListener("loadedmetadata", onMetadata, { once: true });
	});
}

/**
 * Enters or leaves PiP, reporting what happened instead of throwing. `video` is the element the
 * player owns: `document.querySelector("video")` is fine for one player but not for the room,
 * where a queue preview or a rebuilt element can be the first one in the document.
 */
export async function togglePictureInPicture(
	video: HTMLVideoElement | null | undefined,
	doc: PictureInPictureDocument = document as PictureInPictureDocument,
	options: { metadataTimeoutMs?: number } = {},
): Promise<PictureInPictureOutcome> {
	const state = pictureInPictureState(doc);
	if (state !== "ready") {
		return state;
	}
	if (!video) {
		return "no-video";
	}
	try {
		if (doc.pictureInPictureElement) {
			await doc.exitPictureInPicture?.();
			return "left";
		}
		if (video.disablePictureInPicture) {
			return "disabled";
		}
		if (!(await whenMetadataReady(video, options.metadataTimeoutMs))) {
			return "rejected";
		}
		await video.requestPictureInPicture();
		return "entered";
	} catch (error) {
		console.warn("Picture-in-Picture failed:", error);
		return "rejected";
	}
}

/**
 * Whether the browser is showing this document's video in its floating window.
 *
 * Firefox keeps painting the page's picture next to the PiP copy, so the room covers it (see
 * OmniPlayer) and the enhancement layer stands down: the floating window carries the raw video,
 * so drawing the chain would only burn GPU time on a picture nobody can see.
 *
 * The events do not bubble, but they still travel down the tree, so a capture listener on
 * `document` sees them wherever the player element is.
 */
export const pictureInPictureActive = ref(false);

function syncFromDocument() {
	if (typeof document === "undefined") {
		return;
	}
	pictureInPictureActive.value = !!document.pictureInPictureElement;
}

if (typeof document !== "undefined") {
	document.addEventListener("enterpictureinpicture", syncFromDocument, true);
	document.addEventListener("leavepictureinpicture", syncFromDocument, true);
}
