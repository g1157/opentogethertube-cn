import { afterEach, describe, expect, it, vi } from "vitest";
import { serverErrorMessage } from "@/util/server-error";

describe("server error messages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the network when the request never got a response", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		// Callers pass `error.response?.data?.error`, so a missing object means the request
		// never reached the server; a generic "something went wrong" would hide that.
		expect(serverErrorMessage(undefined)).toBe("网络请求失败，请检查网络后重试。");
		expect(serverErrorMessage(null)).toBe("网络请求失败，请检查网络后重试。");
	});

	it("maps known server error names to localized text", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(serverErrorMessage({ name: "TooManyRequests" })).toBe(
			"操作太频繁，请稍等片刻再试。",
		);
		expect(serverErrorMessage({ name: "PermissionDeniedException" })).toBe(
			"你没有执行此操作的权限。",
		);
		expect(serverErrorMessage({ name: "LengthOutOfRangeException" })).toBe(
			"输入内容长度不符合要求，请调整后重试。",
		);
	});

	it("keeps the generic message for unknown names and logs the raw error instead", () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const message = serverErrorMessage({
			name: "SomeNewException",
			message: "internal english detail",
		});
		expect(message).toBe("操作失败，请稍后再试。");
		expect(logged).toHaveBeenCalled();
		expect(message).not.toContain("internal english detail");
	});
});
