import { describe, expect, it } from "vitest";
import { corsFromHeaders } from "../../../services/cors-probe.js";

describe("cross-origin verdict from response headers", () => {
	it("reads the header a browser needs", () => {
		expect(corsFromHeaders({ "access-control-allow-origin": "*" })).toBe(true);
		expect(corsFromHeaders({ "access-control-allow-origin": "https://ott.example" })).toBe(
			true,
		);
	});

	it("treats a response without the header as cross-origin denied", () => {
		expect(corsFromHeaders({ "content-type": "video/mp4" })).toBe(false);
		expect(corsFromHeaders({ "access-control-allow-origin": "" })).toBe(false);
	});

	it("compares a specific allowlist entry with the page's actual origin", () => {
		expect(
			corsFromHeaders(
				{ "access-control-allow-origin": "https://ott.example" },
				"https://ott.example",
			),
		).toBe(true);
		expect(
			corsFromHeaders(
				{ "access-control-allow-origin": "https://other.example" },
				"https://ott.example",
			),
		).toBe(false);
		expect(
			corsFromHeaders(
				{ "access-control-allow-origin": "https://OTT.EXAMPLE" },
				"https://ott.example",
			),
		).toBe(true);
	});

	it("keeps the wildcard valid regardless of the requesting origin", () => {
		expect(corsFromHeaders({ "access-control-allow-origin": "*" }, "https://ott.example")).toBe(
			true,
		);
	});

	it("does not guess when there were no headers at all", () => {
		expect(corsFromHeaders(undefined)).toBeUndefined();
	});
});
