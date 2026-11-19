import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { ok } from "ott-common/result.js";
import { router, mailer } from "../../usermanager.js";
import { User as UserModel } from "../../models/index.js";
import type { User } from "../../models/user.js";
import { redisClient } from "../../redisclient.js";
import * as rateLimit from "../../rate-limit.js";
import { conf } from "../../ott-config.js";

// Recovery boundary tests never connect to SQL, Redis or an external mail service.
vi.mock("../../models/index.js", () => ({
	User: { findOne: vi.fn() },
	Room: { update: vi.fn() },
}));
vi.mock("../../redisclient.js", () => ({
	redisClient: { get: vi.fn(), setEx: vi.fn(), del: vi.fn() },
	delPattern: vi.fn(),
}));

const app = express();
app.use(express.json());
app.use("/user", router);
const oldEnabled = conf.get("rate_limit.enabled");
const oldMailEnabled = conf.get("mail.enabled");

describe("account recovery rate-limit short circuit", () => {
	beforeEach(() => {
		conf.set("rate_limit.enabled", true);
		conf.set("mail.enabled", true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		conf.set("rate_limit.enabled", oldEnabled);
		conf.set("mail.enabled", oldMailEnabled);
	});

	function deny() {
		return vi.spyOn(rateLimit, "consumeRateLimitPoints").mockImplementation(async res => {
			res.status(429).json({ success: false });
			return false;
		});
	}

	it("does not look up accounts, create a reset key or send mail after a 429", async () => {
		const limit = deny();
		const lookup = vi
			.spyOn(UserModel, "findOne")
			.mockResolvedValue({ email: "review@example.invalid" } as User);
		const write = vi.spyOn(redisClient, "setEx").mockResolvedValue("OK");
		const send = vi.spyOn(mailer, "send").mockResolvedValue(ok(undefined));
		await request(app)
			.post("/user/recover/start")
			.send({ email: "review@example.invalid" })
			.expect(429);
		expect(limit).toHaveBeenCalledWith(expect.anything(), expect.any(String), 100);
		expect(lookup).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("does not consume a verification key or change an account after a 429", async () => {
		const limit = deny();
		const read = vi.spyOn(redisClient, "get").mockResolvedValue(null);
		const lookup = vi.spyOn(UserModel, "findOne").mockResolvedValue(null);
		const remove = vi.spyOn(redisClient, "del").mockResolvedValue(1);
		await request(app)
			.post("/user/recover/verify")
			.send({ verifyKey: "review-key", newPassword: "validPassword123" })
			.expect(429);
		expect(limit).toHaveBeenCalledWith(expect.anything(), expect.any(String), 10);
		expect(read).not.toHaveBeenCalled();
		expect(lookup).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("still sends a reset email when rate-limit admission succeeds", async () => {
		vi.spyOn(rateLimit, "consumeRateLimitPoints").mockResolvedValue(true);
		vi.spyOn(UserModel, "findOne").mockResolvedValue({
			email: "review@example.invalid",
		} as User);
		const write = vi.spyOn(redisClient, "setEx").mockResolvedValue("OK");
		const send = vi.spyOn(mailer, "send").mockResolvedValue(ok(undefined));
		await request(app)
			.post("/user/recover/start")
			.send({ email: "review@example.invalid" })
			.expect(200);
		expect(write).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ to: "review@example.invalid" }),
		);
	});
});
