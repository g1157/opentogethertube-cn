import { ApiError, type Env, type GuestSession } from "./types";

export const COOKIE_NAME = "ott_edge_preview_token";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export async function digest(value: string): Promise<string> {
	const data = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(data), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function requestToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith("Bearer ")) {
		return authorization.slice(7);
	}
	const cookies = request.headers.get("Cookie")?.split(";") ?? [];
	return (
		cookies
			.map(item => item.trim())
			.find(item => item.startsWith(`${COOKIE_NAME}=`))
			?.slice(COOKIE_NAME.length + 1) ?? null
	);
}

export async function findSession(
	db: D1Database,
	token: string | null,
): Promise<GuestSession | null> {
	if (!token || !TOKEN_PATTERN.test(token)) {
		return null;
	}
	return db
		.prepare(
			"SELECT token_hash, identity_id, username, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
		)
		.bind(await digest(token), Date.now())
		.first<GuestSession>();
}

export async function requireSession(request: Request, env: Env): Promise<GuestSession> {
	const session = await findSession(env.DB, requestToken(request));
	if (!session) {
		throw new ApiError(401, "请刷新页面以重新取得访客身份。", "MissingToken");
	}
	return session;
}

export async function limit(
	db: D1Database,
	key: string,
	maximum: number,
	windowMs = 60_000,
): Promise<void> {
	const bucket = Math.floor(Date.now() / windowMs);
	const row = await db
		.prepare(`INSERT INTO rate_limits(limit_key, used, expires_at) VALUES (?, 1, ?)
		ON CONFLICT(limit_key) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used`)
		.bind(`${key}:${bucket}`, (bucket + 1) * windowMs, maximum)
		.first();
	if (!row) {
		throw new ApiError(429, "操作较频繁，请稍后再试。", "RateLimitExceeded");
	}
}

export async function grant(request: Request, env: Env): Promise<Response> {
	let token = requestToken(request);
	const existing = await findSession(env.DB, token);
	if (existing) {
		if (existing.expires_at - Date.now() < SESSION_MS / 2) {
			await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
				.bind(Date.now() + SESSION_MS, existing.token_hash)
				.run();
		}
	} else {
		const ip = request.headers.get("CF-Connecting-IP") ?? "local-development";
		await limit(env.DB, `identity:${await digest(ip)}`, 30);
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		token = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
		const identity = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO sessions(token_hash, identity_id, username, expires_at) VALUES (?, ?, ?, ?)",
		)
			.bind(
				await digest(token),
				identity,
				`访客_${identity.slice(0, 6)}`,
				Date.now() + SESSION_MS,
			)
			.run();
	}
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return Response.json(
		{ token },
		{
			headers: {
				"Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`,
				"Cache-Control": "no-store, max-age=0",
			},
		},
	);
}

export function checkOrigin(request: Request): void {
	const origin = request.headers.get("Origin");
	if (
		(origin && origin !== new URL(request.url).origin) ||
		request.headers.get("Sec-Fetch-Site") === "cross-site"
	) {
		throw new ApiError(403, "不允许从其他站点提交操作。", "InvalidOrigin");
	}
}
