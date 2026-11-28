import type { VideoAdd } from "ott-common/models/video.js";
import {
	getSubtitleFormatFromUrl,
	isPublicSubtitleUrl,
	type SubtitleFormat,
} from "ott-common/subtitles.js";

/**
 * Emby is contacted by the browser, never by the OTT server: a home Emby server is
 * usually unreachable from the internet, and routing a movie through the OTT host would
 * turn a watch party into a bandwidth relay. This module only knows the Emby HTTP API;
 * playback stays between each viewer and the Emby server.
 */

export const EMBY_SERVER_STORAGE_KEY = "ott-emby-server";
export const EMBY_USERNAME_STORAGE_KEY = "ott-emby-username";
export const EMBY_DEVICE_STORAGE_KEY = "ott-emby-device-id";

const EMBY_REQUEST_TIMEOUT_MS = 20_000;
const EMBY_ITEM_LIMIT = 60;
const EMBY_VERSION = "1.0.0";
const SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
const TRAILING_SLASHES = /\/+$/;
const WEB_UI_PATH = /\/web(?:\/index\.html)?$/;
const INDEX_HTML_PATH = /\/index\.html$/;
const LEADING_SLASHES = /^\/+/;
const URL_EXTENSION = /\.([a-z0-9]+)$/i;

export class EmbyError extends Error {
	constructor(
		message: string,
		readonly kind: "invalid" | "network" | "timeout" | "unauthorized" | "http" | "unsupported",
		readonly status?: number,
	) {
		super(message);
		this.name = "EmbyError";
	}
}

export interface EmbyAuthResult {
	token: string;
	userId: string;
	userName: string;
	serverId?: string;
}

export interface EmbyView {
	Id: string;
	Name: string;
	CollectionType?: string;
}

export interface EmbyMediaStream {
	Type?: string;
	Codec?: string;
	Index?: number;
	Language?: string;
	DisplayTitle?: string;
	Title?: string;
	IsDefault?: boolean;
	IsForced?: boolean;
	IsExternal?: boolean;
	IsTextSubtitleStream?: boolean;
	DeliveryMethod?: string;
	DeliveryUrl?: string;
	Width?: number;
	Height?: number;
	Channels?: number;
}

export interface EmbyCompatibility {
	/** Direct MKV relies on Chromium/Edge Matroska support; Safari and Firefox cannot play it. */
	chromiumOnly: boolean;
	/** Whether the default audio stream is natively decodable by browsers. */
	audioStatus: "compatible" | "fallback-track" | "incompatible" | "unknown";
	/** Display name of the default audio codec when it is not universally browser-decodable. */
	audioCodec?: string;
	/** Display name of another compatible audio codec in the file, when one exists. */
	compatibleAudioCodec?: string;
	/** Display name of the video codec when it is outside the standard browser codec set. */
	unsupportedVideoCodec?: string;
}

export interface EmbySubtitleTrack {
	/** Stable identifier for the UI selector. */
	key: string;
	url: string;
	format: SubtitleFormat;
	label: string;
	language?: string;
	isDefault: boolean;
	isExternal: boolean;
}

export interface EmbyMediaSource {
	Id?: string;
	Container?: string;
	Protocol?: string;
	RunTimeTicks?: number;
	SupportsDirectPlay?: boolean;
	SupportsDirectStream?: boolean;
	SupportsTranscoding?: boolean;
	DirectStreamUrl?: string;
	TranscodingUrl?: string;
	TranscodingSubProtocol?: string;
	MediaStreams?: EmbyMediaStream[];
}

export interface EmbyItem {
	Id: string;
	Name: string;
	Type?: string;
	Container?: string;
	ProductionYear?: number;
	RunTimeTicks?: number;
	ImageTags?: Record<string, string>;
	MediaSources?: EmbyMediaSource[];
	/** Set on episodes; the tile shows it so a search for a show is readable. */
	SeriesName?: string;
	SeriesId?: string;
	ParentId?: string;
	/** Season number on episodes. */
	ParentIndexNumber?: number;
	/** Episode number within the season. */
	IndexNumber?: number;
}

export interface EmbyPlaybackInfo {
	PlaySessionId?: string;
	MediaSources?: EmbyMediaSource[];
}

export interface PlayableEmbySource {
	service: "direct" | "hls" | "dash";
	url: string;
	mime: string;
	container: string;
	source: EmbyMediaSource;
	/** True when this is a direct MKV fallback that only plays in Chromium-based browsers. */
	limitedCompatibility?: boolean;
	compatibility?: EmbyCompatibility;
}

interface RequestOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

function storageGet(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function storageSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// A blocked storage API must not stop playback; the value is only a convenience.
	}
}

/** Strip trailing slashes and query strings, and require an http(s) origin. */
export function normalizeEmbyServer(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new EmbyError("empty server", "invalid");
	}
	const withScheme = SCHEME_REGEX.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new EmbyError("invalid server URL", "invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new EmbyError("server must use http or https", "invalid");
	}
	if (url.username !== "" || url.password !== "") {
		throw new EmbyError("server URL must not contain credentials", "invalid");
	}
	let path = url.pathname.replace(TRAILING_SLASHES, "");
	// Users often paste the web UI address; the API lives at the same root.
	path = path.replace(WEB_UI_PATH, "");
	path = path.replace(INDEX_HTML_PATH, "");
	return url.origin + path;
}

/** A stable device id makes Emby's session list useful and avoids re-auth churn. */
export function embyDeviceId(): string {
	const existing = storageGet(EMBY_DEVICE_STORAGE_KEY);
	if (existing !== "") {
		return existing;
	}
	const random = window.crypto?.randomUUID?.();
	const id = `ott-${random ?? Math.random().toString(36).slice(2)}`;
	storageSet(EMBY_DEVICE_STORAGE_KEY, id);
	return id;
}

export function rememberEmbyServer(server: string): void {
	storageSet(EMBY_SERVER_STORAGE_KEY, server);
}

export function rememberEmbyUsername(username: string): void {
	storageSet(EMBY_USERNAME_STORAGE_KEY, username);
}

function authorizationHeader(deviceId: string): string {
	return `MediaBrowser Client="OpenTogetherTube", Device="Web", DeviceId="${deviceId}", Version="${EMBY_VERSION}"`;
}

function apiUrl(server: string, path: string): string {
	return `${server}/${path.replace(LEADING_SLASHES, "")}`;
}

function messageFromBody(body: string): string {
	const trimmed = body.trim();
	if (trimmed === "") {
		return "";
	}
	try {
		const parsed = JSON.parse(trimmed) as { Message?: unknown; message?: unknown };
		const message = parsed.Message ?? parsed.message;
		return typeof message === "string" ? message : trimmed.slice(0, 200);
	} catch {
		return trimmed.slice(0, 200);
	}
}

async function requestJson<T>(
	url: string,
	init: RequestInit,
	options: RequestOptions = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), EMBY_REQUEST_TIMEOUT_MS);
	const abortFromCaller = () => controller.abort();
	options.signal?.addEventListener("abort", abortFromCaller);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			...init,
			signal: controller.signal,
			credentials: "omit",
			cache: "no-store",
			headers: {
				Accept: "application/json",
				...init.headers,
			},
		});
		if (response.status === 401) {
			throw new EmbyError("Emby rejected the credentials", "unauthorized", 401);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new EmbyError(
				`Emby returned HTTP ${response.status}${
					messageFromBody(body) ? `: ${messageFromBody(body)}` : ""
				}`,
				"http",
				response.status,
			);
		}
		return (await response.json()) as T;
	} catch (error) {
		if (error instanceof EmbyError) {
			throw error;
		}
		if (controller.signal.aborted) {
			throw new EmbyError("Emby request timed out", "timeout");
		}
		throw new EmbyError(
			error instanceof Error ? error.message : "Could not reach the Emby server",
			"network",
		);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

export async function authenticateEmby(
	server: string,
	username: string,
	password: string,
	deviceId: string,
	options: RequestOptions = {},
): Promise<EmbyAuthResult> {
	const body = await requestJson<{
		AccessToken?: string;
		ServerId?: string;
		User?: { Id?: string; Name?: string };
	}>(
		apiUrl(server, "Users/AuthenticateByName"),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Emby-Authorization": authorizationHeader(deviceId),
			},
			body: JSON.stringify({ Username: username, Pw: password }),
		},
		options,
	);
	if (!body.AccessToken || !body.User?.Id) {
		throw new EmbyError("Emby returned an incomplete login response", "http");
	}
	return {
		token: body.AccessToken,
		userId: body.User.Id,
		userName: body.User.Name ?? username,
		serverId: body.ServerId,
	};
}

/** Used for the display name in the queue description; failure is not fatal. */
export async function getEmbyServerName(
	server: string,
	options: RequestOptions = {},
): Promise<string> {
	try {
		const body = await requestJson<{ ServerName?: string }>(
			apiUrl(server, "System/Info/Public"),
			{ method: "GET" },
			options,
		);
		if (typeof body.ServerName === "string" && body.ServerName.trim() !== "") {
			return body.ServerName.trim();
		}
	} catch (error) {
		console.warn("Could not read the Emby server name:", error);
	}
	return new URL(server).host;
}

export async function getEmbyViews(
	server: string,
	token: string,
	userId: string,
	options: RequestOptions = {},
): Promise<EmbyView[]> {
	const body = await requestJson<{ Items?: EmbyView[] }>(
		apiUrl(server, `Users/${encodeURIComponent(userId)}/Views`),
		{
			method: "GET",
			headers: { "X-Emby-Token": token },
		},
		options,
	);
	return (body.Items ?? []).filter(view => typeof view.Id === "string");
}

export interface EmbyItemsResult {
	items: EmbyItem[];
	total: number;
}

export async function listEmbyItems(
	server: string,
	token: string,
	userId: string,
	params: {
		parentId?: string;
		search?: string;
		startIndex?: number;
		limit?: number;
		/**
		 * Emby item types to return. Library and search views include `Series` so a show
		 * itself is reachable: searching a show name otherwise returns only its episodes,
		 * each indistinguishable from the next. Browsing a series asks for episodes only.
		 */
		itemTypes?: string;
		/** Emby sort fields; browsing a series needs season/episode order, not titles. */
		sortBy?: string;
	},
	options: RequestOptions = {},
): Promise<EmbyItemsResult> {
	const search = params.search?.trim() ?? "";
	const query = new URLSearchParams({
		Recursive: "true",
		IncludeItemTypes: params.itemTypes ?? "Movie,Series,Episode",
		Fields: "ProductionYear,RunTimeTicks,ImageTags,SeriesInfo,MediaSources",
		ImageTypeLimit: "1",
		EnableImageTypes: "Primary",
		SortBy: params.sortBy ?? "SortName",
		SortOrder: "Ascending",
		Limit: String(params.limit ?? EMBY_ITEM_LIMIT),
		StartIndex: String(params.startIndex ?? 0),
	});
	if (search === "") {
		if (params.parentId) {
			query.set("ParentId", params.parentId);
		}
	} else {
		query.set("SearchTerm", search);
	}
	const body = await requestJson<{ Items?: EmbyItem[]; TotalRecordCount?: number }>(
		apiUrl(server, `Users/${encodeURIComponent(userId)}/Items?${query.toString()}`),
		{
			method: "GET",
			headers: { "X-Emby-Token": token },
		},
		options,
	);
	return {
		items: (body.Items ?? []).filter(item => typeof item.Id === "string"),
		total: body.TotalRecordCount ?? body.Items?.length ?? 0,
	};
}

const DIRECT_PROFILE = {
	MaxStreamingBitrate: 120_000_000,
	DirectPlayProfiles: [
		{
			Container: "mp4,m4v,webm,ogg",
			Type: "Video",
			VideoCodec: "h264,hevc,vp8,vp9,av1",
			AudioCodec: "aac,mp3,opus,flac,vorbis",
		},
	],
	TranscodingProfiles: [
		{
			Container: "ts",
			Type: "Video",
			VideoCodec: "h264",
			AudioCodec: "aac,mp3",
			Protocol: "hls",
			Context: "Streaming",
			CopyTimestamps: false,
		},
	],
	SubtitleProfiles: [
		{ Format: "ass", Method: "External" },
		{ Format: "ssa", Method: "External" },
		{ Format: "vtt", Method: "External" },
		{ Format: "srt", Method: "External" },
	],
};

export async function getEmbyPlaybackInfo(
	server: string,
	token: string,
	userId: string,
	itemId: string,
	options: RequestOptions = {},
): Promise<EmbyPlaybackInfo> {
	const query = new URLSearchParams({
		UserId: userId,
		StartTimeTicks: "0",
		AutoOpenLiveStream: "true",
		EnableDirectPlay: "true",
		EnableDirectStream: "true",
		EnableTranscoding: "true",
	});
	return requestJson<EmbyPlaybackInfo>(
		apiUrl(server, `Items/${encodeURIComponent(itemId)}/PlaybackInfo?${query.toString()}`),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Emby-Token": token,
			},
			body: JSON.stringify({
				UserId: userId,
				StartTimeTicks: 0,
				IsPlayback: true,
				AutoOpenLiveStream: true,
				EnableDirectPlay: true,
				EnableDirectStream: true,
				EnableTranscoding: true,
				DeviceProfile: DIRECT_PROFILE,
			}),
		},
		options,
	);
}

export const MIME_BY_EXTENSION: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	ogg: "video/ogg",
	mov: "video/quicktime",
	m3u8: "application/x-mpegURL",
	mpd: "application/dash+xml",
};

/**
 * Containers that Chromium/Edge can direct-play natively when Emby refuses to transcode,
 * even though Safari and Firefox cannot. Kept separate from `MIME_BY_EXTENSION` so Emby's
 * HLS transcode stream always wins when available.
 */
export const LIMITED_DIRECT_MIME_BY_EXTENSION: Record<string, string> = {
	mkv: "video/x-matroska",
	mk3d: "video/x-matroska",
	matroska: "video/x-matroska",
};

const ASS_SUBTITLE_CODECS = new Set(["ass", "ssa"]);
const TEXT_SUBTITLE_CODECS = new Set([
	"vtt",
	"webvtt",
	"srt",
	"subrip",
	"sub",
	"mov_text",
	"tx3g",
	"smi",
	"sami",
	"ttml",
	"dfxp",
]);
const BITMAP_SUBTITLE_CODECS = new Set([
	"pgssub",
	"hdmv_pgs_subtitle",
	"dvdsub",
	"dvd_subtitle",
	"dvbsub",
	"dvb_subtitle",
	"vobsub",
	"xsub",
]);
const CHINESE_LANGUAGE_CODES = new Set(["zh", "zho", "chi", "chs", "cht", "cmn", "yue"]);
const CHINESE_LABEL_PATTERN =
	/(?:中文|简体|繁体|繁體|简中|繁中|国语|國語|双语|雙語|\b(?:chs|cht|sc|tc|zh(?:-cn|-tw|-hk|-hans|-hant)?)\b)/i;
const FIREFOX_UA_PATTERN = /firefox|fxios/i;
const IOS_WEBKIT_UA_PATTERN = /crios|edgios|iphone|ipad|ipod/i;
const SAFARI_UA_PATTERN = /safari/i;
const CHROMIUM_UA_PATTERN = /chrome|chromium|edg|opr|opera/i;

function extensionOf(url: URL): string {
	const match = URL_EXTENSION.exec(url.pathname);
	return match?.[1]?.toLowerCase() ?? "";
}

function appendApiKey(rawUrl: string, token: string): string {
	if (!token) {
		return rawUrl;
	}
	try {
		const url = new URL(rawUrl);
		if (!url.searchParams.has("api_key") && !url.searchParams.has("ApiKey")) {
			url.searchParams.set("api_key", token);
		}
		return url.href;
	} catch {
		return rawUrl;
	}
}

export function analyzeEmbyCompatibility(
	container: string | undefined,
	streams: EmbyMediaStream[] | undefined,
): EmbyCompatibility {
	const normalizedContainer = normalizeEmbyContainer(container);
	const chromiumOnly = normalizedContainer === "mkv" || normalizedContainer === "mk3d";
	const videoStream = streams?.find(stream => stream.Type === "Video");
	const videoRaw = videoStream?.Codec?.trim().toLowerCase() ?? "";
	const unsupportedVideoCodec =
		videoRaw !== "" && !DIRECT_VIDEO_CODECS.has(videoRaw)
			? formatEmbyCodec(videoRaw) || videoRaw.toUpperCase()
			: undefined;

	const audioStreams = (streams ?? []).filter(stream => stream.Type === "Audio");
	let audioStatus: EmbyCompatibility["audioStatus"] = "unknown";
	let audioCodec: string | undefined;
	let compatibleAudioCodec: string | undefined;

	if (audioStreams.length > 0) {
		const defaultAudio = audioStreams.find(stream => stream.IsDefault) ?? audioStreams[0];
		const defaultRaw = defaultAudio.Codec?.trim().toLowerCase() ?? "";
		if (defaultRaw !== "") {
			if (DIRECT_AUDIO_CODECS.has(defaultRaw)) {
				audioStatus = "compatible";
			} else {
				audioCodec = formatEmbyCodec(defaultRaw) || defaultRaw.toUpperCase();
				const fallback = audioStreams.find(stream => {
					const codec = stream.Codec?.trim().toLowerCase() ?? "";
					return codec !== "" && DIRECT_AUDIO_CODECS.has(codec);
				});
				if (fallback) {
					audioStatus = "fallback-track";
					compatibleAudioCodec = formatEmbyCodec(fallback.Codec) || undefined;
				} else {
					audioStatus = "incompatible";
				}
			}
		}
	}

	return {
		chromiumOnly,
		audioStatus,
		...(audioCodec ? { audioCodec } : {}),
		...(compatibleAudioCodec ? { compatibleAudioCodec } : {}),
		...(unsupportedVideoCodec ? { unsupportedVideoCodec } : {}),
	};
}

/**
 * Coarse client-side hint for MKV direct-play messaging. Never blocks adding or playback:
 * the room may have Chromium viewers even if the person queueing is on Safari or Firefox.
 */
export function isCurrentBrowserLikelyNonChromium(
	userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
	if (!userAgent) {
		return false;
	}
	if (FIREFOX_UA_PATTERN.test(userAgent)) {
		return true;
	}
	// On iOS/iPadOS, Chrome (CriOS) and Edge (EdgiOS) are WebKit-backed and cannot play MKV.
	if (IOS_WEBKIT_UA_PATTERN.test(userAgent)) {
		return true;
	}
	// Desktop Safari includes Safari/ without Chrome/Chromium/Edg/Opera tokens.
	if (SAFARI_UA_PATTERN.test(userAgent) && !CHROMIUM_UA_PATTERN.test(userAgent)) {
		return true;
	}
	return false;
}

function absoluteUrl(server: string, raw: string): string {
	try {
		const base = new URL(server);
		const resolved = new URL(raw, `${server}/`);
		// A reverse proxy mounted Emby at /emby may still return root-relative
		// "/videos/..." URLs. Keep the mount prefix instead of dropping it.
		if (
			resolved.origin === base.origin &&
			base.pathname !== "/" &&
			raw.startsWith("/") &&
			resolved.pathname !== base.pathname &&
			!resolved.pathname.startsWith(`${base.pathname}/`)
		) {
			return `${base.origin}${base.pathname}${resolved.pathname}${resolved.search}${resolved.hash}`;
		}
		return resolved.href;
	} catch {
		return raw;
	}
}

function playableFromUrl(
	server: string,
	raw: string,
	source: EmbyMediaSource,
	kind: "direct" | "transcode",
): PlayableEmbySource | undefined {
	if (!raw) {
		return undefined;
	}
	const absolute = absoluteUrl(server, raw);
	let url: URL;
	try {
		url = new URL(absolute);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return undefined;
	}
	const extension = extensionOf(url);
	// `TranscodingSubProtocol` describes the MediaSource, not this particular URL: Emby sets
	// it to "hls" even when it hands back an untouched `DirectStreamUrl` for an MKV. Reading
	// it while classifying the direct URL turned /videos/1/original.mkv into an "HLS" source,
	// which the player then fed to hls.js as a playlist. Only the transcode URL may use it.
	const protocol =
		kind === "transcode" ? source.TranscodingSubProtocol?.toLowerCase() : undefined;
	let service: PlayableEmbySource["service"] | undefined;
	let mime = MIME_BY_EXTENSION[extension];
	let limitedCompatibility = false;
	if (mime !== undefined) {
		service = extension === "m3u8" ? "hls" : extension === "mpd" ? "dash" : "direct";
	} else if (kind === "direct" && LIMITED_DIRECT_MIME_BY_EXTENSION[extension] !== undefined) {
		service = "direct";
		mime = LIMITED_DIRECT_MIME_BY_EXTENSION[extension];
		limitedCompatibility = true;
	} else if (protocol === "hls") {
		// Some Emby versions return an extensionless /videos/{id}/stream URL for HLS.
		service = "hls";
		mime = "application/x-mpegURL";
	} else if (protocol === "dash") {
		service = "dash";
		mime = "application/dash+xml";
	} else {
		// A static direct URL may also omit the extension; trust its declared container.
		const container = normalizeEmbyContainer(source.Container);
		mime = MIME_BY_EXTENSION[container];
		if (mime !== undefined && container !== "m3u8" && container !== "mpd") {
			service = "direct";
		} else if (kind === "direct" && LIMITED_DIRECT_MIME_BY_EXTENSION[container] !== undefined) {
			service = "direct";
			mime = LIMITED_DIRECT_MIME_BY_EXTENSION[container];
			limitedCompatibility = true;
		}
	}
	if (service === undefined || mime === undefined) {
		return undefined;
	}
	const container =
		normalizeEmbyContainer(extension || source.Container) ||
		extension ||
		source.Container?.toLowerCase() ||
		"unknown";
	return {
		service,
		url: absolute,
		mime,
		container,
		source,
		...(limitedCompatibility ? { limitedCompatibility: true } : {}),
		...(service === "direct"
			? { compatibility: analyzeEmbyCompatibility(container, source.MediaStreams) }
			: {}),
	};
}

export interface PlayableSourceResult {
	source?: PlayableEmbySource;
	reason?: string;
	/**
	 * The server offered a direct URL but no transcode URL at all. That is what a shared
	 * Emby looks like when the admin disables transcoding for the account: there is nothing
	 * to pick, so telling the user to enable transcoding would be advice they cannot take.
	 */
	directOnly?: boolean;
}

export interface PickPlayableOptions {
	/** Used only to build a static direct URL if Emby omits `DirectStreamUrl` on a direct-play source. */
	token?: string;
}

function synthesizeDirectStreamUrl(
	item: EmbyItem,
	source: EmbyMediaSource,
	token: string | undefined,
): string {
	if (
		!token ||
		!source.Id ||
		(source.SupportsDirectPlay !== true && source.SupportsDirectStream !== true)
	) {
		return "";
	}
	const container = normalizeEmbyContainer(source.Container ?? item.Container);
	const isDirectContainer =
		(MIME_BY_EXTENSION[container] !== undefined &&
			container !== "m3u8" &&
			container !== "mpd") ||
		LIMITED_DIRECT_MIME_BY_EXTENSION[container] !== undefined;
	if (!isDirectContainer) {
		return "";
	}
	const query = new URLSearchParams({
		Static: "true",
		mediaSourceId: source.Id,
	});
	query.set("api_key", token);
	return `/Videos/${encodeURIComponent(item.Id)}/stream.${container}?${query.toString()}`;
}

/**
 * Prefer universal direct play (MP4/WebM/OGG), then Emby's HLS/DASH transcoding stream
 * (which works on every browser including Safari/Firefox and fixes AC3/DTS audio), and
 * finally fall back to direct MKV playback for Chromium/Edge when Emby disables transcoding.
 */
export function pickPlayableEmbySource(
	server: string,
	playback: EmbyPlaybackInfo,
	item: EmbyItem,
	options: PickPlayableOptions = {},
): PlayableSourceResult {
	const sources = playback.MediaSources ?? item.MediaSources ?? [];
	const candidates: PlayableEmbySource[] = [];
	for (const source of sources) {
		const rawDirect =
			source.DirectStreamUrl ||
			(!source.TranscodingUrl ? synthesizeDirectStreamUrl(item, source, options.token) : "");
		const direct = playableFromUrl(server, rawDirect, source, "direct");
		if (direct) {
			candidates.push(direct);
		}
		const transcoded = playableFromUrl(
			server,
			source.TranscodingUrl ?? "",
			source,
			"transcode",
		);
		if (transcoded) {
			candidates.push(transcoded);
		}
	}
	if (candidates.length > 0) {
		// Universal direct play first, then server HLS/DASH transcode, then Chromium-only MKV direct play.
		const rank = (source: PlayableEmbySource) => {
			if (source.service === "direct" && !source.limitedCompatibility) {
				return 0;
			}
			if (source.service === "hls") {
				return 1;
			}
			if (source.service === "dash") {
				return 2;
			}
			return 3;
		};
		candidates.sort((a, b) => rank(a) - rank(b));
		return { source: candidates[0] };
	}
	const container = sources[0]?.Container ?? item.MediaSources?.[0]?.Container ?? "unknown";
	const hasDirect = sources.some(source => (source.DirectStreamUrl ?? "") !== "");
	const hasTranscode = sources.some(source => (source.TranscodingUrl ?? "") !== "");
	return { reason: container, directOnly: hasDirect && !hasTranscode };
}

function formatSubtitleLabel(
	stream: EmbyMediaStream,
	format: SubtitleFormat,
	index: number,
): string {
	const base =
		stream.DisplayTitle?.trim() ||
		stream.Title?.trim() ||
		stream.Language?.trim().toUpperCase() ||
		`Track ${index + 1}`;
	const tag = format.toUpperCase();
	if (base.toUpperCase().includes(tag)) {
		return base;
	}
	return `${base} · ${tag}`;
}

/**
 * Extract browser-usable text subtitles (ASS/SSA via jassub, VTT via native <track>) from
 * an Emby MediaSource. Only URLs accepted by the room's public-subtitle guard are returned
 * so LAN Emby servers never cause queue requests to fail validation.
 */
export function extractEmbySubtitles(
	server: string,
	token: string,
	item: EmbyItem,
	mediaSource: EmbyMediaSource | undefined,
): EmbySubtitleTrack[] {
	if (!mediaSource?.MediaStreams?.length) {
		return [];
	}
	const tracks: EmbySubtitleTrack[] = [];
	const seenUrls = new Set<string>();

	for (let i = 0; i < mediaSource.MediaStreams.length; i++) {
		const stream = mediaSource.MediaStreams[i];
		if (stream.Type !== "Subtitle") {
			continue;
		}
		const codec = stream.Codec?.trim().toLowerCase() ?? "";
		if (stream.IsTextSubtitleStream === false || BITMAP_SUBTITLE_CODECS.has(codec)) {
			continue;
		}
		const isAss = ASS_SUBTITLE_CODECS.has(codec);
		const isKnownText = isAss || TEXT_SUBTITLE_CODECS.has(codec);
		if (!isKnownText && stream.IsTextSubtitleStream !== true) {
			continue;
		}
		const targetFormat: SubtitleFormat = isAss ? "ass" : "vtt";

		let url = "";
		let format: SubtitleFormat = targetFormat;

		if (stream.DeliveryUrl) {
			const candidate = appendApiKey(absoluteUrl(server, stream.DeliveryUrl), token);
			const candidateFormat = getSubtitleFormatFromUrl(candidate);
			if (candidateFormat !== null && (!isAss || candidateFormat === "ass")) {
				url = candidate;
				format = candidateFormat;
			}
		}

		if (!url && mediaSource.Id && typeof stream.Index === "number") {
			const rawPath = `/Videos/${encodeURIComponent(item.Id)}/${encodeURIComponent(
				mediaSource.Id,
			)}/Subtitles/${stream.Index}/Stream.${targetFormat}?api_key=${encodeURIComponent(token)}`;
			url = absoluteUrl(server, rawPath);
			format = targetFormat;
		}

		if (!url || seenUrls.has(url)) {
			continue;
		}
		if (getSubtitleFormatFromUrl(url) === null || !isPublicSubtitleUrl(url)) {
			continue;
		}
		seenUrls.add(url);
		tracks.push({
			key: typeof stream.Index === "number" ? `stream-${stream.Index}` : `url-${i}`,
			url,
			format,
			label: formatSubtitleLabel(stream, format, i),
			language: stream.Language?.trim().toLowerCase() || undefined,
			isDefault: stream.IsDefault === true,
			isExternal: stream.IsExternal === true,
		});
	}
	return tracks;
}

function matchesPreferredLocale(track: EmbySubtitleTrack, locale: string): boolean {
	const normalizedLocale = locale.trim().toLowerCase();
	if (normalizedLocale.startsWith("zh")) {
		if (track.language && CHINESE_LANGUAGE_CODES.has(track.language)) {
			return true;
		}
		return CHINESE_LABEL_PATTERN.test(track.label);
	}
	const primary = normalizedLocale.split("-")[0];
	if (!primary) {
		return false;
	}
	return track.language === primary || track.language?.startsWith(`${primary}-`) === true;
}

/** Pick the best default Emby subtitle track (preferring locale match, default flag, then ASS). */
export function pickDefaultEmbySubtitle(
	tracks: EmbySubtitleTrack[],
	locale = "",
): EmbySubtitleTrack | undefined {
	if (tracks.length === 0) {
		return undefined;
	}
	const score = (track: EmbySubtitleTrack) => {
		let points = 0;
		if (locale && matchesPreferredLocale(track, locale)) {
			points += 8;
		}
		if (track.isDefault) {
			points += 4;
		}
		// ASS renders via jassub independently of <video crossorigin>, and preserves styling.
		if (track.format === "ass") {
			points += 2;
		}
		if (track.isExternal) {
			points += 1;
		}
		return points;
	};
	return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

export function embyItemImageUrl(
	server: string,
	token: string,
	item: EmbyItem,
	maxHeight = 360,
): string | undefined {
	const tag = item.ImageTags?.Primary;
	if (!tag) {
		return undefined;
	}
	const query = new URLSearchParams({
		maxHeight: String(maxHeight),
		quality: "90",
		tag,
	});
	query.set("api_key", token);
	return apiUrl(
		server,
		`Items/${encodeURIComponent(item.Id)}/Images/Primary?${query.toString()}`,
	);
}

export interface EmbyVideoOptions {
	server: string;
	serverName: string;
	token: string;
	item: EmbyItem;
	source: PlayableEmbySource;
	/** Optional public ASS/VTT subtitle URL attached to direct-play sources. */
	subtitleUrl?: string;
}

/** Build the queue payload. The playback URL necessarily carries this Emby token. */
export function embyItemToVideoAdd(options: EmbyVideoOptions): VideoAdd {
	const { server, serverName, token, item, source, subtitleUrl } = options;
	const videoStream = source.source.MediaStreams?.find(stream => stream.Type === "Video");
	const ticks = source.source.RunTimeTicks ?? item.RunTimeTicks;
	const length =
		typeof ticks === "number" && Number.isFinite(ticks) && ticks > 0
			? Math.ceil(ticks / 10_000_000)
			: undefined;
	const width =
		typeof videoStream?.Width === "number" && videoStream.Width > 0
			? videoStream.Width
			: undefined;
	const height =
		typeof videoStream?.Height === "number" && videoStream.Height > 0
			? videoStream.Height
			: undefined;
	const usableSubtitle =
		source.service === "direct" &&
		typeof subtitleUrl === "string" &&
		subtitleUrl !== "" &&
		getSubtitleFormatFromUrl(subtitleUrl) !== null &&
		isPublicSubtitleUrl(subtitleUrl)
			? subtitleUrl
			: undefined;
	return {
		service: source.service,
		id: source.url,
		...(usableSubtitle ? { subtitleUrl: usableSubtitle } : {}),
		metadata: {
			title: item.Name || "Emby",
			description: `Emby · ${serverName}`,
			mime: source.mime,
			length,
			thumbnail: embyItemImageUrl(server, token, item),
			width,
			height,
			cors: true,
		},
	};
}

/**
 * `S02E05` for an episode. Emby leaves the numbers unset for some libraries and for
 * anything that is not an episode, and a bare `S00E00` would be worse than nothing.
 */
export function formatEmbyEpisodeCode(item: EmbyItem): string {
	const season = item.ParentIndexNumber;
	const episode = item.IndexNumber;
	if (typeof season !== "number" || typeof episode !== "number") {
		return "";
	}
	if (!Number.isFinite(season) || !Number.isFinite(episode) || (season <= 0 && episode <= 0)) {
		return "";
	}
	return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function formatEmbyRuntime(ticks: number | undefined): string {
	if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks <= 0) {
		return "";
	}
	const totalMinutes = Math.round(ticks / 10_000_000 / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export type EmbyPlayabilityStatus =
	| "direct"
	| "direct-limited"
	| "transcode"
	| "unsupported"
	| "unknown";

export interface EmbyMediaSummary {
	status: EmbyPlayabilityStatus;
	/** True when derived from list-level Container without PlaybackInfo verification. */
	estimated: boolean;
	container: string;
	videoCodec?: string;
	audioCodec?: string;
	resolution?: string;
	/** Human-readable spec label, e.g. "mkv · HEVC · AC3" or "mp4". */
	label: string;
	compatibility?: EmbyCompatibility;
}

const DIRECT_VIDEO_CODECS = new Set([
	"h264",
	"avc",
	"avc1",
	"hevc",
	"h265",
	"hev1",
	"hvc1",
	"vp8",
	"vp9",
	"av1",
	"av01",
]);
const DIRECT_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);

const CODEC_DISPLAY_NAMES: Record<string, string> = {
	h264: "H264",
	avc: "H264",
	avc1: "H264",
	hevc: "HEVC",
	h265: "HEVC",
	hev1: "HEVC",
	hvc1: "HEVC",
	vp9: "VP9",
	vp8: "VP8",
	av1: "AV1",
	av01: "AV1",
	aac: "AAC",
	ac3: "AC3",
	eac3: "EAC3",
	"ec-3": "EAC3",
	dts: "DTS",
	dca: "DTS",
	truehd: "TrueHD",
	opus: "OPUS",
	mp3: "MP3",
	flac: "FLAC",
	vorbis: "Vorbis",
};

/** Normalize Emby/FFmpeg container strings (e.g. "mov,mp4,m4a,..." -> "mp4", "matroska" -> "mkv"). */
export function normalizeEmbyContainer(raw: string | undefined): string {
	if (!raw) {
		return "";
	}
	const tokens = raw
		.toLowerCase()
		.split(",")
		.map(token => token.trim())
		.filter(token => token !== "");
	if (tokens.length === 0) {
		return "";
	}
	if (tokens.includes("mp4")) {
		return "mp4";
	}
	if (tokens[0] === "matroska") {
		return "mkv";
	}
	return tokens[0];
}

/** True when the container can be played natively in browsers without HLS/DASH transcoding. */
export function isDirectPlayContainer(container: string | undefined): boolean {
	const normalized = normalizeEmbyContainer(container);
	return (
		normalized !== "" &&
		normalized !== "m3u8" &&
		normalized !== "mpd" &&
		MIME_BY_EXTENSION[normalized] !== undefined
	);
}

export function formatEmbyCodec(codec: string | undefined): string {
	const trimmed = codec?.trim().toLowerCase() ?? "";
	if (trimmed === "") {
		return "";
	}
	return CODEC_DISPLAY_NAMES[trimmed] ?? trimmed.toUpperCase();
}

export function formatEmbyResolution(width?: number, height?: number): string {
	const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : 0;
	const h = typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
	if (w === 0 && h === 0) {
		return "";
	}
	if (h >= 2100 || w >= 3800) {
		return "4K";
	}
	if (h >= 1400 || w >= 2500) {
		return "1440p";
	}
	if (h >= 1000 || w >= 1800) {
		return "1080p";
	}
	if (h >= 700 || w >= 1200) {
		return "720p";
	}
	if (h >= 450) {
		return "480p";
	}
	return h > 0 ? `${h}p` : "";
}

export function formatEmbyMediaLabel(parts: {
	container?: string;
	videoCodec?: string;
	audioCodec?: string;
}): string {
	return [parts.container, parts.videoCodec, parts.audioCodec]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" · ");
}

function extractStreamDetails(streams: EmbyMediaStream[] | undefined) {
	const video = streams?.find(stream => stream.Type === "Video");
	const audio = streams?.find(stream => stream.Type === "Audio");
	const videoRaw = video?.Codec?.trim().toLowerCase() ?? "";
	const audioRaw = audio?.Codec?.trim().toLowerCase() ?? "";
	const videoCodec = formatEmbyCodec(videoRaw) || undefined;
	const audioCodec = formatEmbyCodec(audioRaw) || undefined;
	const resolution = formatEmbyResolution(video?.Width, video?.Height) || undefined;
	return { videoRaw, audioRaw, videoCodec, audioCodec, resolution };
}

/**
 * Coarse playability summary derived solely from list-level Fields (`Container` and any
 * already-attached MediaSources) without firing per-item PlaybackInfo requests.
 */
export function summarizeEmbyItemMedia(item: EmbyItem): EmbyMediaSummary | undefined {
	if (item.Type === "Series") {
		return undefined;
	}
	const container = normalizeEmbyContainer(item.Container ?? item.MediaSources?.[0]?.Container);
	const details = extractStreamDetails(item.MediaSources?.[0]?.MediaStreams);
	const label = formatEmbyMediaLabel({
		container,
		videoCodec: details.videoCodec,
		audioCodec: details.audioCodec,
	});
	if (label === "") {
		return undefined;
	}
	const hasStreams = details.videoRaw !== "" || details.audioRaw !== "";
	let status: EmbyPlayabilityStatus;
	if (!isDirectPlayContainer(container) && !hasStreams) {
		// `.strm` items point at a URL Emby resolves later: the real container and codecs
		// are unknown here, and guessing "needs transcoding" would be wrong half the time.
		status = "unknown";
	} else if (isDirectPlayContainer(container)) {
		const videoOk = details.videoRaw === "" || DIRECT_VIDEO_CODECS.has(details.videoRaw);
		const audioOk = details.audioRaw === "" || DIRECT_AUDIO_CODECS.has(details.audioRaw);
		status = videoOk && audioOk ? "direct" : "transcode";
	} else {
		status = "transcode";
	}
	return {
		status,
		// With MediaStreams in hand the codec check is exact; only the server's willingness
		// to transcode is still a guess.
		estimated: !hasStreams,
		container,
		videoCodec: details.videoCodec,
		audioCodec: details.audioCodec,
		resolution: details.resolution,
		label,
	};
}

/**
 * Exact playability summary built from Emby's PlaybackInfo response and pickPlayableEmbySource.
 */
export function summarizeEmbyPlaybackMedia(
	item: EmbyItem,
	playback: EmbyPlaybackInfo,
	result: PlayableSourceResult,
): EmbyMediaSummary {
	const mediaSource =
		result.source?.source ?? playback.MediaSources?.[0] ?? item.MediaSources?.[0];
	const container = normalizeEmbyContainer(
		mediaSource?.Container ?? item.Container ?? result.source?.container ?? result.reason,
	);
	const details = extractStreamDetails(mediaSource?.MediaStreams);
	const label = formatEmbyMediaLabel({
		container: container || undefined,
		videoCodec: details.videoCodec,
		audioCodec: details.audioCodec,
	});
	let status: EmbyPlayabilityStatus;
	if (!result.source) {
		status = "unsupported";
	} else if (result.source.service === "direct" && result.source.limitedCompatibility) {
		status = "direct-limited";
	} else if (result.source.service === "direct") {
		status = "direct";
	} else {
		status = "transcode";
	}
	return {
		status,
		estimated: false,
		container,
		videoCodec: details.videoCodec,
		audioCodec: details.audioCodec,
		resolution: details.resolution,
		label,
		...(result.source?.compatibility ? { compatibility: result.source.compatibility } : {}),
	};
}
