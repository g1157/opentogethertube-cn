import WebSocket from "ws";
import { getLogger } from "./logger.js";
import { conf } from "./ott-config.js";
import type { Server } from "node:http";
import type { Socket } from "node:net";

const log = getLogger("websockets");
export const wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024 });

function allowedOriginsForHost(host: string | undefined): Set<string> {
	const allowed = new Set<string>();
	if (!host) {
		return allowed;
	}
	let bareHost: string;
	try {
		bareHost = new URL(host.includes("://") ? host : `http://${host}`).host;
	} catch {
		return allowed;
	}
	for (const protocol of ["http:", "https:"]) {
		try {
			allowed.add(new URL(`${protocol}//${bareHost}`).origin);
		} catch {
			// An unparseable configured host simply contributes no origin.
		}
	}
	return allowed;
}

/**
 * A browser page may only open the room socket from the same origin it is served from.
 * Non-browser clients (no Origin header) are allowed; the Bearer token remains the actual
 * authentication. Comparing against both Host and the configured hostname covers raw-IP
 * entries and reverse proxies that rewrite Host.
 */
export function isAllowedWebSocketOrigin(
	origin: string | string[] | undefined,
	requestHost: string | undefined,
	configuredHostname: string | undefined,
): boolean {
	if (origin === undefined) {
		return true;
	}
	if (typeof origin !== "string") {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		// Includes the literal "null" origin sent by sandboxed documents.
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return false;
	}
	for (const host of [requestHost, configuredHostname]) {
		if (allowedOriginsForHost(host).has(parsed.origin)) {
			return true;
		}
	}
	return false;
}

/**
 * Set up the websocket server.
 */
export function setup(httpServer: Server) {
	log.debug("setting up websocket upgrader...");
	wss.on("error", e => {
		log.error(`Websocket server error: ${e}`);
	});
	httpServer.on("upgrade", (req, socket, head) => {
		if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, conf.get("hostname"))) {
			log.warn(
				`Rejecting websocket upgrade from origin ${String(req.headers.origin)} (host ${String(
					req.headers.host,
				)})`,
			);
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket as Socket, head, ws => {
			wss.emit("connection", ws, req);
		});
	});
}

export default {
	setup,
	wss,
};
