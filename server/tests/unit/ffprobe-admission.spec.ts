import { afterEach, describe, expect, it, vi } from "vitest";
import { FfprobeError, FfprobeTimeoutError } from "../../exceptions.js";
import { probeMediaInfo, type FfprobeStrategy } from "../../ffprobe.js";

const QUEUE_LIMIT = 32;
const WAIT_TIMEOUT_MS = 5000;
const INFO = { format: { duration: "1" } };
let poolSequence = 0;
const pools: { drain: () => Promise<void> }[] = [];

async function observeRejection(
	result: Promise<unknown>,
	onRejected: (error: unknown) => void = () => undefined,
): Promise<void> {
	try {
		await result;
	} catch (error) {
		onRejected(error);
	}
}

async function probeAfterMicrotask(pool: ReturnType<typeof createPool>, id: string): Promise<void> {
	await Promise.resolve();
	pool.probe(id);
}
async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}

function createPool() {
	const prefix = `https://example.com/probe-admission-${poolSequence++}/`;
	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const results: Promise<unknown>[] = [];
	const started: string[] = [];
	let running = 0;
	let maximum = 0;
	let draining = false;
	let throwNext = false;
	const getFileInfo = (uri: string) => {
		const id = uri.slice(prefix.length);
		started.push(id);
		if (throwNext) {
			throwNext = false;
			throw new FfprobeError("synchronous strategy failure");
		}
		running++;
		maximum = Math.max(maximum, running);
		if (draining) {
			running--;
			return Promise.resolve(INFO);
		}
		return new Promise<unknown>((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
	};
	const strategy = { getFileInfo } as unknown as FfprobeStrategy;
	const pool = {
		started,
		get maximum() {
			return maximum;
		},
		probe(id: string) {
			const result = probeMediaInfo(strategy, prefix + id);
			results.push(result);
			void observeRejection(result);
			return result;
		},
		finish(id: string, error?: Error) {
			const operation = pending.get(id);
			if (!operation) {
				throw new Error(`Probe ${id} has not started.`);
			}
			pending.delete(id);
			running--;
			if (error) {
				operation.reject(error);
			} else {
				operation.resolve(INFO);
			}
		},
		failSynchronously() {
			throwNext = true;
		},
		async drain() {
			draining = true;
			for (const id of Array.from(pending.keys())) {
				pool.finish(id);
			}
			await Promise.allSettled(results);
		},
	};
	pools.push(pool);
	return pool;
}

function occupySlots(pool: ReturnType<typeof createPool>): void {
	for (let index = 0; index < 4; index++) {
		pool.probe(`holder-${index}`);
	}
	expect(pool.started).toHaveLength(4);
}

function fillQueue(pool: ReturnType<typeof createPool>): void {
	for (let index = 0; index < QUEUE_LIMIT; index++) {
		pool.probe(`waiter-${index}`);
	}
}

describe("ffprobe slot admission", () => {
	afterEach(async () => {
		for (const pool of pools.splice(0)) {
			await pool.drain();
		}
		vi.useRealTimers();
	});

	it("reserves a transferred slot before a newcomer can steal it", async () => {
		const pool = createPool();
		occupySlots(pool);
		pool.probe("waiter");
		pool.finish("holder-0");
		// This arrival runs between releasing the holder and resuming the queued waiter.
		void probeAfterMicrotask(pool, "newcomer");
		await flushMicrotasks();
		expect(pool.maximum).toBeLessThanOrEqual(4);
		expect(pool.started).toEqual(["holder-0", "holder-1", "holder-2", "holder-3", "waiter"]);
		pool.finish("holder-1");
		await flushMicrotasks();
		expect(pool.started.at(-1)).toBe("newcomer");
	});

	it("passes released slots to waiters in arrival order", async () => {
		const pool = createPool();
		occupySlots(pool);
		pool.probe("first");
		pool.probe("second");
		pool.finish("holder-0");
		await flushMicrotasks();
		pool.probe("third");
		pool.finish("holder-1");
		await flushMicrotasks();
		expect(pool.started.slice(4)).toEqual(["first", "second"]);
		pool.finish("first");
		await flushMicrotasks();
		expect(pool.started.at(-1)).toBe("third");
		expect(pool.maximum).toBe(4);
	});

	it("rejects overflow without starting another strategy", async () => {
		const pool = createPool();
		occupySlots(pool);
		fillQueue(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("overflow"), rejected);
		await flushMicrotasks();
		expect(rejected).toHaveBeenCalledWith(expect.any(FfprobeError));
		expect(rejected.mock.calls[0][0].message).toContain("queue");
		expect(pool.started).toHaveLength(4);
	});

	it("does not cache an overflow as an upstream media failure", async () => {
		const pool = createPool();
		occupySlots(pool);
		fillQueue(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("retry"), rejected);
		await flushMicrotasks();
		expect(rejected).toHaveBeenCalledTimes(1);
		pool.finish("holder-0");
		await flushMicrotasks();
		const retryRejected = vi.fn();
		void observeRejection(pool.probe("retry"), retryRejected);
		await flushMicrotasks();
		expect(retryRejected).not.toHaveBeenCalled();
		await pool.drain();
		expect(pool.started.filter(id => id === "retry")).toHaveLength(1);
	});

	it("expires a waiting probe at its own deadline and never starts it later", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("expired"), rejected);
		await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS - 1);
		expect(rejected).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(rejected).toHaveBeenCalledWith(expect.any(FfprobeTimeoutError));
		pool.finish("holder-0");
		await flushMicrotasks();
		expect(pool.started).not.toContain("expired");
	});

	it("measures the deadline separately for each queued request", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		const firstRejected = vi.fn();
		const secondRejected = vi.fn();
		void observeRejection(pool.probe("first"), firstRejected);
		await vi.advanceTimersByTimeAsync(3000);
		void observeRejection(pool.probe("second"), secondRejected);
		await vi.advanceTimersByTimeAsync(2000);
		expect(firstRejected).toHaveBeenCalledTimes(1);
		expect(secondRejected).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(3000);
		expect(secondRejected).toHaveBeenCalledTimes(1);
	});

	it("removes timed-out waiters from the admission queue", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		fillQueue(pool);
		await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS);
		const rejected = vi.fn();
		void observeRejection(pool.probe("replacement"), rejected);
		await flushMicrotasks();
		expect(rejected).not.toHaveBeenCalled();
		pool.finish("holder-0");
		await flushMicrotasks();
		expect(pool.started.slice(4)).toEqual(["replacement"]);
	});

	it("does not cache a queue timeout and permits immediate retry", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("retry"), rejected);
		await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS);
		expect(rejected).toHaveBeenCalledTimes(1);
		pool.finish("holder-0");
		await flushMicrotasks();
		const retry = pool.probe("retry");
		expect(pool.started.at(-1)).toBe("retry");
		pool.finish("retry");
		await expect(retry).resolves.toEqual(INFO);
	});

	it("does not admit an expired waiter before a delayed timer callback", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("expired"), rejected);
		// Advancing the clock without firing timers simulates an occupied event loop.
		vi.setSystemTime(Date.now() + WAIT_TIMEOUT_MS);
		pool.finish("holder-0");
		await flushMicrotasks();
		expect(rejected).toHaveBeenCalledWith(expect.any(FfprobeTimeoutError));
		expect(pool.started).not.toContain("expired");
		pool.probe("replacement");
		expect(pool.started.at(-1)).toBe("replacement");
		expect(pool.maximum).toBe(4);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("skips expired FIFO entries and transfers the slot to a live waiter", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("expired"), rejected);
		vi.setSystemTime(Date.now() + 3000);
		pool.probe("live");
		vi.setSystemTime(Date.now() + 2000);
		pool.finish("holder-0");
		await flushMicrotasks();
		expect(rejected).toHaveBeenCalledTimes(1);
		expect(pool.started.slice(4)).toEqual(["live"]);
		expect(pool.maximum).toBe(4);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("clears the wait timer before the admitted strategy resumes", async () => {
		vi.useFakeTimers();
		const pool = createPool();
		occupySlots(pool);
		const rejected = vi.fn();
		void observeRejection(pool.probe("waiter"), rejected);
		pool.finish("holder-0");
		await Promise.resolve();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS);
		expect(rejected).not.toHaveBeenCalled();
		expect(pool.started.at(-1)).toBe("waiter");
	});

	it("releases a slot after an active strategy rejects", async () => {
		const pool = createPool();
		occupySlots(pool);
		pool.probe("waiter");
		pool.finish("holder-0", new FfprobeError("upstream failure"));
		await flushMicrotasks();
		expect(pool.started.at(-1)).toBe("waiter");
		expect(pool.maximum).toBe(4);
	});

	it("releases a slot after a synchronous strategy throw", async () => {
		const pool = createPool();
		pool.failSynchronously();
		await expect(pool.probe("failed")).rejects.toThrow("synchronous strategy failure");
		for (let index = 0; index < 4; index++) {
			pool.probe(`holder-${index}`);
		}
		expect(pool.started.slice(1)).toHaveLength(4);
		expect(pool.maximum).toBe(4);
	});

	it("deduplicates queued probes without consuming another queue position", async () => {
		const pool = createPool();
		occupySlots(pool);
		for (let index = 0; index < QUEUE_LIMIT - 1; index++) {
			pool.probe(`waiter-${index}`);
		}
		const first = pool.probe("duplicate");
		const second = pool.probe("duplicate");
		expect(second).toBe(first);
		const rejected = vi.fn();
		void observeRejection(pool.probe("overflow"), rejected);
		await flushMicrotasks();
		expect(rejected).toHaveBeenCalledTimes(1);
		await pool.drain();
		expect(pool.started.filter(id => id === "duplicate")).toHaveLength(1);
	});
});
