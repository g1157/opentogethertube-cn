import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_INTERVAL_MS, installClientUpdateCheck } from "@/util/client-update";

describe("client build updates", () => {
	let watcher: ReturnType<typeof installClientUpdateCheck> | undefined;
	let currentUrl: string;
	const navigate = vi.fn();
	const updateUrl = vi.fn();
	const request = vi.fn();
	const flush = async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	};
	const reply = (data: unknown) =>
		request.mockResolvedValue({ ok: true, json: async () => data });
	const start = (revision = "aaaaaaa") => {
		watcher = installClientUpdateCheck({
			revision,
			versionUrl: "/api/status/version",
			getUrl: () => currentUrl,
			navigate,
			updateUrl,
		});
	};
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.stubGlobal("fetch", request);
		vi.spyOn(document, "hidden", "get").mockReturnValue(false);
		currentUrl = "https://example.com/room/watch?view=chat#player";
		reply({ revision: "aaaaaaa0000000000000000000000000000000000" });
	});
	afterEach(() => {
		watcher?.dispose();
		document.body.innerHTML = "";
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("revalidates without caching and keeps the matching build", async () => {
		start();
		await flush();
		expect(request).toHaveBeenCalledWith(
			"/api/status/version",
			expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
		);
		expect(navigate).not.toHaveBeenCalled();
	});
	it("polls a Cloudflare release and keeps the matching version", async () => {
		reply({ revision: "cloudflare-preview-0.1.2" });
		start("cloudflare-preview-0.1.2");
		await flush();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(request).toHaveBeenCalledTimes(2);
		expect(navigate).not.toHaveBeenCalled();
	});
	it("treats Cloudflare patch versions as exact values, not Git hash prefixes", async () => {
		reply({ revision: "cloudflare-preview-0.1.10" });
		start("cloudflare-preview-0.1.1");
		await flush();
		expect(navigate).toHaveBeenCalledWith(
			"https://example.com/room/watch?view=chat&_ott_update=cloudflare-preview-0.1.10#player",
		);
	});
	it("cleans a matching Cloudflare update marker and prevents stale-release reload loops", async () => {
		currentUrl = "https://example.com/room/watch?_ott_update=cloudflare-preview-0.1.2";
		reply({ revision: "cloudflare-preview-0.1.2" });
		start("cloudflare-preview-0.1.2");
		expect(updateUrl).toHaveBeenCalledWith("https://example.com/room/watch");
		watcher?.dispose();
		start("cloudflare-preview-0.1.1");
		await flush();
		expect(navigate).not.toHaveBeenCalled();
	});
	it("does not poll development placeholders", async () => {
		start("development");
		await vi.advanceTimersByTimeAsync(60000);
		expect(request).not.toHaveBeenCalled();
	});
	it("refreshes once for a new revision while retaining room, query and hash", async () => {
		reply({ revision: "bbbbbbb" });
		start();
		await flush();
		expect(navigate).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith(
			"https://example.com/room/watch?view=chat&_ott_update=bbbbbbb#player",
		);
		await vi.advanceTimersByTimeAsync(60000);
		expect(navigate).toHaveBeenCalledOnce();
	});
	it("does not loop if a refreshed document still contains a stale build", async () => {
		currentUrl = "https://example.com/room/watch?_ott_update=bbbbbbb";
		reply({ revision: "bbbbbbb" });
		start();
		await flush();
		await vi.advanceTimersByTimeAsync(30000);
		expect(navigate).not.toHaveBeenCalled();
	});
	it("retains the loop guard if the router removes the temporary query", async () => {
		currentUrl = "https://example.com/room/watch?_ott_update=bbbbbbb";
		reply({ revision: "bbbbbbb" });
		start();
		currentUrl = "https://example.com/room/watch";
		await flush();
		expect(navigate).not.toHaveBeenCalled();
	});
	it("cleans the temporary URL marker once the new build has loaded", () => {
		currentUrl = "https://example.com/room/watch?view=chat&_ott_update=aaaaaaa#player";
		start();
		expect(updateUrl).toHaveBeenCalledWith("https://example.com/room/watch?view=chat#player");
	});
	it.each([
		null,
		{},
		{ revision: null },
		{ revision: "unknown" },
		{ revision: "https://evil.test" },
	])("ignores an unavailable or malformed version: %j", async data => {
		reply(data);
		start();
		await flush();
		expect(navigate).not.toHaveBeenCalled();
	});
	it("retries after a network failure when the page becomes active", async () => {
		request.mockRejectedValueOnce(new Error("offline"));
		start();
		await flush();
		reply({ revision: "bbbbbbb" });
		window.dispatchEvent(new Event("pageshow"));
		await flush();
		expect(navigate).toHaveBeenCalledOnce();
	});
	it("defers while an input is being edited and checks after editing", async () => {
		const input = document.createElement("textarea");
		document.body.append(input);
		input.focus();
		reply({ revision: "bbbbbbb" });
		start();
		expect(request).not.toHaveBeenCalled();
		input.blur();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(navigate).toHaveBeenCalledOnce();
	});
	it("stops polling and ignores late responses after disposal", async () => {
		let resolve: (value: unknown) => void = () => undefined;
		request.mockReturnValue(
			new Promise(done => {
				resolve = done;
			}),
		);
		start();
		watcher?.dispose();
		resolve({ ok: true, json: async () => ({ revision: "bbbbbbb" }) });
		await flush();
		await vi.advanceTimersByTimeAsync(60000);
		window.dispatchEvent(new Event("online"));
		expect(request).toHaveBeenCalledOnce();
		expect(navigate).not.toHaveBeenCalled();
	});
	it("rechecks editing state when a delayed version response arrives", async () => {
		let resolve: (value: unknown) => void = () => undefined;
		request.mockReturnValue(
			new Promise(done => {
				resolve = done;
			}),
		);
		start();
		const input = document.createElement("textarea");
		document.body.append(input);
		input.focus();
		resolve({ ok: true, json: async () => ({ revision: "bbbbbbb" }) });
		await flush();
		expect(navigate).not.toHaveBeenCalled();
		input.blur();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(navigate).toHaveBeenCalledOnce();
	});
});
