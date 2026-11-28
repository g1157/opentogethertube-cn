import type { VideoAdd } from "ott-common/models/video.js";

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

interface EmbyMediaStream {
	Type?: string;
	Codec?: string;
	Width?: number;
	Height?: number;
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
	ProductionYear?: number;
	RunTimeTicks?: number;
	ImageTags?: Record<string, string>;
	MediaSources?: EmbyMediaSource[];
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
				`Emby returned HTTP ${response.status}${messageFromBody(body) ? `: ${messageFromBody(body)}` : ""}`,
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
	},
	options: RequestOptions = {},
): Promise<EmbyItemsResult> {
	const search = params.search?.trim() ?? "";
	const query = new URLSearchParams({
		Recursive: "true",
		IncludeItemTypes: "Movie,Episode",
		Fields: "ProductionYear,RunTimeTicks,ImageTags",
		ImageTypeLimit: "1",
		EnableImageTypes: "Primary",
		SortBy: "SortName",
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
	SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
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

const MIME_BY_EXTENSION: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	ogg: "video/ogg",
	mov: "video/quicktime",
	m3u8: "application/x-mpegURL",
	mpd: "application/dash+xml",
};

function extensionOf(url: URL): string {
	const match = URL_EXTENSION.exec(url.pathname);
	return match?.[1]?.toLowerCase() ?? "";
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
	const mime = MIME_BY_EXTENSION[extension];
	if (mime === undefined) {
		return undefined;
	}
	let service: PlayableEmbySource["service"];
	if (extension === "m3u8") {
		service = "hls";
	} else if (extension === "mpd") {
		service = "dash";
	} else {
		service = "direct";
	}
	return {
		service,
		url: absolute,
		mime,
		container: extension,
		source,
	};
}

export interface PlayableSourceResult {
	source?: PlayableEmbySource;
	reason?: string;
}

/**
 * Prefer Emby's direct URL; fall back to its HLS transcoding URL only when the browser
 * cannot take the original container. An MKV stays unsupported rather than being sent to
 * the OTT server for remuxing.
 */
export function pickPlayableEmbySource(
	server: string,
	playback: EmbyPlaybackInfo,
	item: EmbyItem,
): PlayableSourceResult {
	const sources = playback.MediaSources ?? item.MediaSources ?? [];
	const candidates: PlayableEmbySource[] = [];
	for (const source of sources) {
		const direct = playableFromUrl(server, source.DirectStreamUrl ?? "", source);
		if (direct) {
			candidates.push(direct);
		}
		const transcoded = playableFromUrl(server, source.TranscodingUrl ?? "", source);
		if (transcoded) {
			candidates.push(transcoded);
		}
	}
	if (candidates.length > 0) {
		// Direct play before transcode; HLS before DASH when both are offered.
		const rank = (source: PlayableEmbySource) =>
			source.service === "direct" ? 0 : source.service === "hls" ? 1 : 2;
		candidates.sort((a, b) => rank(a) - rank(b));
		return { source: candidates[0] };
	}
	const container = sources[0]?.Container ?? item.MediaSources?.[0]?.Container ?? "unknown";
	return { reason: container };
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
}

/** Build the queue payload. The playback URL necessarily carries this Emby token. */
export function embyItemToVideoAdd(options: EmbyVideoOptions): VideoAdd {
	const { server, serverName, token, item, source } = options;
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
	return {
		service: source.service,
		id: source.url,
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

export function formatEmbyRuntime(ticks: number | undefined): string {
	if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks <= 0) {
		return "";
	}
	const totalMinutes = Math.round(ticks / 10_000_000 / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
