import type { RoomObject } from "./room-object";
import type { MaintenanceObject } from "./maintenance-object";

export interface Env {
	ROOMS: DurableObjectNamespace<RoomObject>;
	MAINTENANCE: DurableObjectNamespace<MaintenanceObject>;
	DB: D1Database;
	ASSETS: Fetcher;
	OTT_INSTANCE_ID: string;
	OTT_CLIENT_REVISION: string;
	ROOM_IDLE_SECONDS?: string;
	CHECKPOINT_SECONDS?: string;
}

export interface GuestSession {
	identity_id: string;
	username: string;
	expires_at: number;
	token_hash: string;
}

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		name = "OttException",
	) {
		super(message);
		this.name = name;
	}
}

export function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store, max-age=0",
			Pragma: "no-cache",
			Expires: "0",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function errorResponse(error: unknown): Response {
	if (error instanceof ApiError) {
		return json(
			{ success: false, error: { name: error.name, message: error.message } },
			error.status,
		);
	}
	if (error instanceof Error && error.name === "ZodError") {
		return json(
			{ success: false, error: { name: "InvalidRequest", message: "请求参数不正确。" } },
			400,
		);
	}
	console.error("edge request failed", error instanceof Error ? error.name : "Unknown");
	return json(
		{
			success: false,
			error: { name: "InternalError", message: "暂时无法处理请求，请稍后重试。" },
		},
		500,
	);
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) {
		return {};
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > maxBytes) {
				throw new ApiError(413, "请求内容太大。");
			}
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(data));
	} catch {
		throw new ApiError(400, "请求需要有效的 JSON。");
	}
}
