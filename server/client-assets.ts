import type { ServerResponse } from "node:http";
import { relative, resolve, sep } from "node:path";
import express, { type RequestHandler } from "express";

// Vite's default output names contain an eight-character content hash.
const HASHED_ASSET_PATH = /^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9.]+$/;

export function setNoStoreHeaders(response: Pick<ServerResponse, "setHeader">): void {
	response.setHeader("Cache-Control", "no-store, max-age=0");
	response.setHeader("Pragma", "no-cache");
	response.setHeader("Expires", "0");
}

export function clientStaticFiles(directory: string): RequestHandler {
	const root = resolve(directory);
	return express.static(root, {
		redirect: false,
		index: false,
		cacheControl: false,
		setHeaders(response, filePath) {
			const assetPath = relative(root, filePath).split(sep).join("/");
			if (HASHED_ASSET_PATH.test(assetPath)) {
				response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			} else {
				setNoStoreHeaders(response);
			}
		},
	});
}
