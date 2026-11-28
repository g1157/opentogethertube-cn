import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import request, { type Response } from "supertest";
import passport from "passport";
import type { RateLimiterMemory } from "rate-limiter-flexible";
import usermanager, { router } from "../../usermanager.js";
import { User as UserModel } from "../../models/index.js";
import type { User } from "../../models/user.js";
import { conf } from "../../ott-config.js";

type AuthenticationDone = (error: Error | null, user?: User | false) => void;
const auth = vi.hoisted(() => ({
	mode: "fail" as "fail" | "missing" | "success" | "hold",
	pending: [] as AuthenticationDone[],
	identifiers: [] as string[],
	user: undefined as User | undefined,
	counters: new Map<string, RateLimiterMemory>(),
}));

// Exercise the real HTTP route and real atomic Memory consume/reward behavior using
// production 10/100 point budgets. Passport, sessions and Redis transport are isolated;
// no SQL queries, Redis connection or external authentication service is used here.
vi.mock("../../models/index.js", () => ({
	User: { findOne: vi.fn() },
	Room: { update: vi.fn() },
}));
vi.mock("passport", () => ({
	default: {
		authenticate: vi.fn(
			(_strategy: string, done?: AuthenticationDone): RequestHandler =>
				(req, _res, next) => {
					if (typeof done !== "function") {
						next();
						return;
					}
					auth.identifiers.push(req.body.user);
					if (auth.mode === "hold") {
						auth.pending.push(done);
					} else if (auth.mode === "success") {
						done(null, auth.user);
					} else if (auth.mode === "missing") {
						done(null, false);
					} else {
						done(new Error("Wrong credentials"));
					}
				},
		),
	},
}));
vi.mock("../../auth/tokens.js", () => ({
	default: {
		mint: vi.fn(async () => "isolated-login-token"),
		setSessionInfo: vi.fn(async () => undefined),
		revoke: vi.fn(async () => undefined),
	},
}));
vi.mock("../../rate-limit.js", async importOriginal => {
	const original = await importOriginal<typeof import("../../rate-limit.js")>();
	const { RateLimiterMemory: Memory } = await import("rate-limiter-flexible");
	class RecordingLimiter extends Memory {
		constructor(options: ConstructorParameters<typeof Memory>[0]) {
			// Short test TTLs avoid Node's 90-day Memory timer overflow; points are unchanged.
			super({ ...options, duration: 60, blockDuration: 30 });
			auth.counters.set(this.keyPrefix, this);
		}
	}
	return { ...original, RateLimiterRedisv4: RecordingLimiter };
});

const IP = "198.51.100.20";
const IP_COUNTER = "login_fail_ip_per_day";
const USER_COUNTER = "login_fail_consecutive_username_and_ip";
const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use((req, _res, next) => {
	Object.defineProperty(req, "login", {
		value: (_user: unknown, done: (error?: Error) => void) => done(),
	});
	next();
});
app.use("/user", router);
const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
	res.status(500).json({ error: String(error) });
};
app.use(handleError);

const previous = {
	env: conf.get("env"),
	enabled: conf.get("rate_limit.enabled"),
	mailEnabled: conf.get("mail.enabled"),
};
let inFlight: Promise<Response>[] = [];
let responses: Response[] = [];
let releases: (() => void)[] = [];

function counter(prefix: string): RateLimiterMemory {
	const limiter = auth.counters.get(prefix);
	if (!limiter) {
		throw new Error("Missing test login limiter: " + prefix);
	}
	return limiter;
}

function complete(error: Error | null, user?: User | false): void {
	for (const done of auth.pending.splice(0)) {
		done(error, user);
	}
}

function startLogin(body: Record<string, string>): Promise<Response> {
	const pending = (async () => {
		const response = await request(app)
			.post("/user/login")
			.set("X-Forwarded-For", IP)
			.send(body);
		responses.push(response);
		return response;
	})();
	inFlight.push(pending);
	return pending;
}

function attempt(identifier: string, field: "user" | "email" | "username" = "user") {
	return startLogin({ [field]: identifier, password: "wrong-password" });
}

async function points(prefix: string, key: string): Promise<number> {
	return (await counter(prefix).get(key))?.consumedPoints ?? 0;
}

describe("login rate-limit admission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		auth.mode = "fail";
		auth.pending.length = 0;
		auth.identifiers.length = 0;
		auth.counters.clear();
		inFlight = [];
		responses = [];
		releases = [];
		conf.set("env", "development");
		conf.set("rate_limit.enabled", true);
		conf.set("mail.enabled", false);
		usermanager.setup();
		auth.user = { id: 1, username: "CaseUser", email: "case@example.invalid" } as User;
		vi.spyOn(UserModel, "findOne").mockRejectedValue(new Error("Unexpected SQL lookup"));
	});

	afterEach(async () => {
		auth.mode = "fail";
		for (const release of releases.splice(0)) {
			release();
		}
		complete(new Error("Test cleanup"));
		await Promise.all(inFlight);
		vi.restoreAllMocks();
		conf.set("env", previous.env);
		conf.set("rate_limit.enabled", previous.enabled);
		conf.set("mail.enabled", previous.mailEnabled);
		usermanager.setup();
	});

	it("limits a same-user burst before any authentication completes", async () => {
		auth.mode = "hold";
		for (let index = 0; index < 15; index++) {
			attempt("CaseUser");
		}
		await vi.waitFor(
			() => {
				expect(auth.pending).toHaveLength(10);
				expect(responses).toHaveLength(5);
			},
			{ timeout: 15_000 },
		);
		expect(responses.every(response => response.status === 429)).toBe(true);
		expect(passport.authenticate).toHaveBeenCalledTimes(10);
		complete(new Error("Wrong credentials"));
		const finished = await Promise.all(inFlight);
		expect(finished.filter(response => response.status === 401)).toHaveLength(10);
		expect(await points(IP_COUNTER, IP)).toBe(10);
	});

	it("does not inflate the daily IP budget when a large same-user burst is denied", async () => {
		auth.mode = "hold";
		let release: () => void = () => undefined;
		const acknowledged = new Promise<void>(resolve => {
			release = resolve;
			releases.push(resolve);
		});
		const ip = counter(IP_COUNTER);
		const consume = ip.consume.bind(ip);
		// Redis may apply a batch before its replies arrive. Hold the IP acknowledgements,
		// not the atomic counter updates, so partial-admission accounting is exercised.
		const consumeIP = vi.spyOn(ip, "consume").mockImplementation(async (...args) => {
			const [outcome] = await Promise.allSettled([consume(...args)]);
			await acknowledged;
			if (outcome.status === "rejected") {
				throw outcome.reason;
			}
			return outcome.value;
		});
		const consumeUser = vi.spyOn(counter(USER_COUNTER), "consume");
		for (let index = 0; index < 110; index++) {
			attempt("CaseUser");
		}
		await vi.waitFor(() => expect(consumeUser).toHaveBeenCalledTimes(110), {
			timeout: 15_000,
		});
		release();
		await vi.waitFor(
			() => {
				expect(auth.pending).toHaveLength(10);
				expect(responses).toHaveLength(100);
			},
			{ timeout: 15_000 },
		);
		expect(await points(IP_COUNTER, IP)).toBe(10);
		expect(consumeIP).toHaveBeenCalledTimes(10);
		expect(passport.authenticate).toHaveBeenCalledTimes(10);
		complete(new Error("Wrong credentials"));
		await Promise.all(inFlight);
	});

	it("limits a cross-user IP burst before any authentication completes", async () => {
		auth.mode = "hold";
		for (let index = 0; index < 110; index++) {
			attempt("principal-" + index);
		}
		await vi.waitFor(
			() => {
				expect(auth.pending).toHaveLength(100);
				expect(responses).toHaveLength(10);
			},
			{ timeout: 15_000 },
		);
		expect(responses.every(response => response.status === 429)).toBe(true);
		expect(passport.authenticate).toHaveBeenCalledTimes(100);
		complete(new Error("Wrong credentials"));
		const finished = await Promise.all(inFlight);
		expect(finished.filter(response => response.status === 401)).toHaveLength(100);
	});

	it("shares one username bucket across case variants", async () => {
		const variants = [
			"CaseUser",
			"caseUser",
			"CASEUSER",
			"cAseUser",
			"CaSeUser",
			"CasEUser",
			"CaseuSer",
			"caseuser",
			"cASEuSER",
			"caSeUsEr",
		];
		for (const variant of variants) {
			expect((await attempt(variant)).status).toBe(401);
		}
		const denied = await attempt("CASEuser");
		expect(denied.status).toBe(429);
		expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
		expect(passport.authenticate).toHaveBeenCalledTimes(10);
	});

	it.each([
		"user",
		"email",
		"username",
	] as const)("enforces admission for the legacy %s field", async field => {
		for (let index = 0; index < 10; index++) {
			expect((await attempt("CaseUser", field)).status).toBe(401);
		}
		expect((await attempt("caseuser", field)).status).toBe(429);
		expect(passport.authenticate).toHaveBeenCalledTimes(10);
	});

	it("does not change the credential identifier passed to Passport", async () => {
		expect((await attempt("Mixed@Example.invalid", "email")).status).toBe(401);
		expect(auth.identifiers).toEqual(["Mixed@Example.invalid"]);
		expect(await points(USER_COUNTER, "mixed@example.invalid_" + IP)).toBe(1);
	});

	it("keeps missing credentials charged only once per admitted request", async () => {
		auth.mode = "missing";
		for (let index = 0; index < 10; index++) {
			expect((await startLogin({})).status).toBe(401);
		}
		expect((await startLogin({})).status).toBe(429);
		expect(passport.authenticate).toHaveBeenCalledTimes(10);
		expect(await points(IP_COUNTER, IP)).toBe(10);
	});

	it("clears username failures but only refunds its own IP reservation on success", async () => {
		for (let index = 0; index < 2; index++) {
			expect((await attempt("CaseUser")).status).toBe(401);
		}
		auth.mode = "success";
		for (let index = 0; index < 102; index++) {
			expect((await attempt("CaseUser")).status).toBe(200);
		}
		expect(await counter(USER_COUNTER).get("caseuser_" + IP)).toBeNull();
		expect(await points(IP_COUNTER, IP)).toBe(2);
	});

	it("does not consume IP points when the username bucket rejects", async () => {
		for (let index = 0; index < 10; index++) {
			expect((await attempt("CaseUser")).status).toBe(401);
		}
		const consumeIP = vi.spyOn(counter(IP_COUNTER), "consume");
		expect((await attempt("CaseUser")).status).toBe(429);
		expect(consumeIP).not.toHaveBeenCalled();
		expect(await points(IP_COUNTER, IP)).toBe(10);
	});

	it("refunds a new user's reservation when the IP bucket rejects", async () => {
		for (let index = 0; index < 100; index++) {
			expect((await attempt("principal-" + index)).status).toBe(401);
		}
		expect((await attempt("fresh-user")).status).toBe(429);
		expect(await points(USER_COUNTER, "fresh-user_" + IP)).toBe(0);
		expect(passport.authenticate).toHaveBeenCalledTimes(100);
	});

	it.each([
		IP_COUNTER,
		USER_COUNTER,
	])("does not authenticate on %s storage failure", async prefix => {
		vi.spyOn(counter(prefix), "consume").mockRejectedValue(
			new Error("Limiter storage unavailable"),
		);
		expect((await attempt("CaseUser")).status).toBe(500);
		expect(passport.authenticate).not.toHaveBeenCalled();
		expect(await points(IP_COUNTER, IP)).toBe(0);
		expect(await points(USER_COUNTER, "caseuser_" + IP)).toBe(0);
	});

	it("does not access budgets when rate limiting is disabled", async () => {
		conf.set("rate_limit.enabled", false);
		const consume = vi.spyOn(counter(IP_COUNTER), "consume");
		for (let index = 0; index < 15; index++) {
			expect((await attempt("CaseUser")).status).toBe(401);
		}
		expect(consume).not.toHaveBeenCalled();
		expect(await points(IP_COUNTER, IP)).toBe(0);
	});

	it("does not create a refund if limits are enabled while a disabled request is authenticating", async () => {
		conf.set("rate_limit.enabled", false);
		auth.mode = "hold";
		const pending = attempt("CaseUser");
		await vi.waitFor(() => expect(auth.pending).toHaveLength(1));
		conf.set("rate_limit.enabled", true);
		complete(null, auth.user);
		expect((await pending).status).toBe(200);
		expect(await points(IP_COUNTER, IP)).toBe(0);
	});

	it("refunds an admitted request even if limits are disabled during authentication", async () => {
		auth.mode = "hold";
		const pending = attempt("CaseUser");
		await vi.waitFor(() => expect(auth.pending).toHaveLength(1));
		conf.set("rate_limit.enabled", false);
		complete(null, auth.user);
		expect((await pending).status).toBe(200);
		expect(await points(IP_COUNTER, IP)).toBe(0);
	});

	it("remains closed if a denied request's refund fails", async () => {
		await counter(IP_COUNTER).set(IP, 100, 60);
		const refund = vi
			.spyOn(counter(USER_COUNTER), "reward")
			.mockRejectedValue(new Error("Refund storage unavailable"));
		expect((await attempt("CaseUser")).status).toBe(429);
		expect(refund).toHaveBeenCalledWith("caseuser_" + IP);
		expect(passport.authenticate).not.toHaveBeenCalled();
	});
});
