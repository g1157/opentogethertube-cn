import { timingSafeEqual } from "node:crypto";
import { OttException } from "ott-common/exceptions.js";
import { conf } from "./ott-config.js";

/**
 * @deprecated use `conf.get("api_key")` instead
 * @returns the api key
 */
export function getApiKey() {
	return conf.get("api_key");
}

/**
 * @deprecated use `conf.set("api_key", key)` instead
 */
export function setApiKey(key: string) {
	conf.set("api_key", key);
}

/**
 * Constant-time apikey comparison. An unset key never grants anything, and a length
 * mismatch burns comparable time so the check cannot be used as a length oracle.
 */
export function safeCompareApiKey(input: string | undefined | null): boolean {
	const apikey = conf.get("api_key");
	if (!apikey || !input) {
		return false;
	}
	const a = Buffer.from(input);
	const b = Buffer.from(apikey);
	if (a.length !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

export function requireApiKey(input: string) {
	const apikey = conf.get("api_key");
	if (!apikey) {
		throw new OttException("apikey is not set");
	}
	if (!safeCompareApiKey(input)) {
		throw new OttException("apikey is invalid");
	}
}
