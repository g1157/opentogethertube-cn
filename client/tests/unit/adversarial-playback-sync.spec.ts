import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPlaybackSync } from "@/util/playback-sync";

describe("playback sync boundary", () => {
	let sync: ReturnType<typeof createPlaybackSync>;
	let state: ReturnType<Parameters<typeof createPlaybackSync>[0]["getState"]>;
	let getPosition: Mock<[], number>;
	let setPosition: Mock<[number], void>;
	let setLocalRate: Mock<[number], void>;
	let onError: Mock<[unknown], void>;

	beforeEach(() => {
		vi.useFakeTimers();
		state = {
			source: { id: "episode-one" },
			player: {},
			ready: true,
			error: false,
			blocked: false,
			seeking: false,
			recovering: false,
			buffering: false,
			playing: true,
			position: 100,
		};
		getPosition = vi.fn<[], number>(() => 100);
		setPosition = vi.fn<[number], void>();
		setLocalRate = vi.fn<[number], void>();
		onError = vi.fn<[unknown], void>();
		sync = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => 1,
			setLocalRate,
			onError,
		});
	});

	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	/** The first tick always performs the source-change seek; clear it before probing. */
	async function prime() {
		await sync.tick();
		getPosition.mockClear();
		setPosition.mockClear();
		setLocalRate.mockClear();
	}

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("does not read, seek or bend for a non-finite room position (%s)", async bad => {
		await prime();
		state.position = bad;
		getPosition.mockReturnValue(bad);

		await sync.tick();

		expect(getPosition).not.toHaveBeenCalled();
		expect(setPosition).not.toHaveBeenCalled();
		expect(setLocalRate).not.toHaveBeenCalled();
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("does not act on a non-finite player position (%s)", async bad => {
		await prime();
		state.position = 100;
		getPosition.mockReturnValue(bad);

		await sync.tick();

		expect(setPosition).not.toHaveBeenCalled();
		expect(setLocalRate).not.toHaveBeenCalled();
	});

	it("only writes finite rates while bending a real drift", async () => {
		await prime();
		state.position = 100.5;
		getPosition.mockReturnValue(100);

		await sync.tick();

		expect(setLocalRate).toHaveBeenCalled();
		for (const [rate] of setLocalRate.mock.calls) {
			expect(Number.isFinite(rate)).toBe(true);
			expect(rate).toBeGreaterThan(0);
		}
	});

	it("does not seek for a negative player position", async () => {
		await prime();
		state.position = 100;
		getPosition.mockReturnValue(-5);

		await sync.tick();

		for (const [position] of setPosition.mock.calls) {
			expect(Number.isFinite(position)).toBe(true);
			expect(position).toBeGreaterThanOrEqual(0);
		}
	});
});
