import {
	MAX_CLIENT_METADATA_DESCRIPTION_LENGTH,
	MAX_CLIENT_METADATA_LENGTH_SECONDS,
	MAX_CLIENT_METADATA_THUMBNAIL_LENGTH,
	MAX_CLIENT_METADATA_TITLE_LENGTH,
	MAX_VIDEO_ID_LENGTH,
} from "ott-common/constants.js";
import type {
	ClientVideoMetadata,
	MediaAccess,
	Video,
	VideoAdd,
	VideoService,
} from "ott-common/models/video.js";
import { BadApiArgumentException } from "./exceptions.js";
import { isSupportedMimeType } from "./mime.js";

/**
 * Metadata may only ride along with a source whose identity is a URL. Service adapters
 * with a canonical id (YouTube, Vimeo, …) already own their metadata; accepting a client
 * copy there would let a caller bypass the adapter's own validation or cache rules.
 */
const URL_METADATA_SERVICES: ReadonlySet<VideoService> = new Set(["direct", "hls", "dash"]);

function hasControlCharacters(value: string, allowNewlines: boolean): boolean {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (code === undefined) {
			continue;
		}
		if (allowNewlines && (code === 0x09 || code === 0x0a || code === 0x0d)) {
			continue;
		}
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function parseHttpUrl(raw: string, field: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BadApiArgumentException(field, "must be an absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BadApiArgumentException(field, "must use http or https");
	}
	// Credentials in a media URL would be broadcast to every viewer and stored forever.
	if (url.username !== "" || url.password !== "") {
		throw new BadApiArgumentException(field, "must not contain credentials");
	}
	return url;
}

function boundedText(
	value: string,
	field: string,
	maxLength: number,
	allowNewlines: boolean,
): string {
	if (value.length > maxLength) {
		throw new BadApiArgumentException(field, `must be at most ${maxLength} characters`);
	}
	if (hasControlCharacters(value, allowNewlines)) {
		throw new BadApiArgumentException(field, "must not contain control characters");
	}
	return value;
}

function boundedDimension(value: number | undefined, field: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || value < 1 || value > 16384) {
		throw new BadApiArgumentException(field, "must be an integer between 1 and 16384");
	}
	return value;
}

function boundedLength(metadata: ClientVideoMetadata): number | undefined {
	if (metadata.isLive) {
		return undefined;
	}
	if (metadata.length === undefined) {
		return undefined;
	}
	if (
		!Number.isFinite(metadata.length) ||
		metadata.length < 0 ||
		metadata.length > MAX_CLIENT_METADATA_LENGTH_SECONDS
	) {
		throw new BadApiArgumentException(
			"metadata.length",
			`must be between 0 and ${MAX_CLIENT_METADATA_LENGTH_SECONDS}`,
		);
	}
	// A source with no duration and a live source both use undefined; 0 means "unknown"
	// to every adapter, so normalize it away for the same reason.
	const length = Math.ceil(metadata.length);
	return length > 0 ? length : undefined;
}

function boundedMediaAccess(metadata: ClientVideoMetadata): MediaAccess | undefined {
	const source = metadata.mediaAccess;
	if (!source) {
		return undefined;
	}
	const mediaAccess: MediaAccess = {};
	if (source.referrerPolicy === "no-referrer") {
		mediaAccess.referrerPolicy = "no-referrer";
	}
	if (typeof source.requiresOriginReferer === "boolean") {
		mediaAccess.requiresOriginReferer = source.requiresOriginReferer;
	}
	if (typeof source.containerMismatch === "boolean") {
		mediaAccess.containerMismatch = source.containerMismatch;
	}
	return Object.keys(mediaAccess).length > 0 ? mediaAccess : undefined;
}

/**
 * Turn validated client-supplied metadata into a queueable video, or return undefined
 * when the request carries none (the normal adapter path then runs unchanged).
 *
 * Validation is deliberately independent of the REST schema: WebSocket playNow requests
 * never pass through Zod, so the room must not trust either entry point.
 */
export function videoFromClientMetadata(video: VideoAdd): Video | undefined {
	const metadata = video.metadata;
	if (metadata === undefined) {
		return undefined;
	}
	if (!URL_METADATA_SERVICES.has(video.service)) {
		throw new BadApiArgumentException(
			"metadata",
			"only direct, hls and dash sources accept client metadata",
		);
	}
	if (video.id.length === 0 || video.id.length > MAX_VIDEO_ID_LENGTH) {
		throw new BadApiArgumentException("id", "invalid video id");
	}
	parseHttpUrl(video.id, "id");

	const title = boundedText(
		metadata.title,
		"metadata.title",
		MAX_CLIENT_METADATA_TITLE_LENGTH,
		false,
	).trim();
	if (title.length === 0) {
		throw new BadApiArgumentException("metadata.title", "must not be empty");
	}
	if (!isSupportedMimeType(metadata.mime)) {
		throw new BadApiArgumentException("metadata.mime", "is not a supported media type");
	}

	const description =
		metadata.description === undefined
			? ""
			: boundedText(
					metadata.description,
					"metadata.description",
					MAX_CLIENT_METADATA_DESCRIPTION_LENGTH,
					true,
				);
	let thumbnail: string | undefined;
	if (metadata.thumbnail !== undefined) {
		if (metadata.thumbnail.length > MAX_CLIENT_METADATA_THUMBNAIL_LENGTH) {
			throw new BadApiArgumentException(
				"metadata.thumbnail",
				`must be at most ${MAX_CLIENT_METADATA_THUMBNAIL_LENGTH} characters`,
			);
		}
		thumbnail = parseHttpUrl(metadata.thumbnail, "metadata.thumbnail").href;
	}

	const result: Video = {
		service: video.service,
		id: video.id,
		title,
		description,
		mime: metadata.mime,
	};
	const length = boundedLength(metadata);
	if (length !== undefined) {
		result.length = length;
	}
	if (metadata.isLive) {
		result.isLive = true;
	}
	if (thumbnail !== undefined) {
		result.thumbnail = thumbnail;
	}
	const width = boundedDimension(metadata.width, "metadata.width");
	const height = boundedDimension(metadata.height, "metadata.height");
	if (width !== undefined) {
		result.width = width;
	}
	if (height !== undefined) {
		result.height = height;
	}
	if (typeof metadata.cors === "boolean") {
		result.cors = metadata.cors;
	}
	const mediaAccess = boundedMediaAccess(metadata);
	if (mediaAccess !== undefined) {
		result.mediaAccess = mediaAccess;
	}
	return result;
}
