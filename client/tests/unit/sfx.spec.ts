import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, type EffectScope, nextTick } from "vue";
import { OttSfx } from "@/plugins/sfx";

describe("message sound playback", () => {
	let scope: EffectScope;
	let sound: OttSfx;
	let gain: { connect: ReturnType<typeof vi.fn>; gain: { value: number } };
	let start: ReturnType<typeof vi.fn>;
	let createBufferSource: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		gain = { connect: vi.fn(), gain: { value: 1 } };
		start = vi.fn();
		createBufferSource = vi.fn(() => ({ connect: vi.fn(), start, buffer: null }));
		vi.stubGlobal(
			"AudioContext",
			class {
				destination = {};
				createGain() {
					return gain;
				}
				createBufferSource = createBufferSource;
				decodeAudioData(_bytes: ArrayBuffer, resolve: (buffer: AudioBuffer) => void) {
					resolve({} as AudioBuffer);
				}
			},
		);
		vi.spyOn(axios, "get").mockResolvedValue({
			data: { arrayBuffer: async () => new ArrayBuffer(1) },
		});
		scope = effectScope();
		sound = scope.run(() => new OttSfx())!;
	});

	afterEach(() => {
		scope.stop();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("stays silent by default after loading, and only plays while explicitly enabled", async () => {
		await sound.loadSfx();
		expect(sound.enabled).toBe(false);
		await sound.play("pop");
		expect(createBufferSource).not.toHaveBeenCalled();

		sound.enabled = true;
		await sound.play("pop");
		expect(createBufferSource).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledWith(0);

		sound.enabled = false;
		await sound.play("pop");
		expect(createBufferSource).toHaveBeenCalledOnce();
	});

	it("applies the configured message sound volume to its own gain", async () => {
		await sound.loadSfx();
		sound.volume.value = 0.23;
		await nextTick();
		expect(gain.gain.value).toBe(0.23);
	});

	it("does not open an audio device until a sound is actually needed", () => {
		const contexts = vi.fn();
		vi.stubGlobal("AudioContext", contexts);
		const unused = new OttSfx();
		expect(unused).toBeDefined();
		expect(contexts).not.toHaveBeenCalled();
	});

	it("loads on the first enabled sound and reuses the decoded asset", async () => {
		await sound.play("pop");
		expect(axios.get).not.toHaveBeenCalled();
		sound.enabled = true;
		await sound.play("pop");
		await sound.play("pop");
		expect(axios.get).toHaveBeenCalledOnce();
		expect(createBufferSource).toHaveBeenCalledTimes(2);
	});

	it("shares one load when callers arrive together", async () => {
		await Promise.all([sound.loadSfx(), sound.loadSfx()]);
		expect(axios.get).toHaveBeenCalledOnce();
		expect(axios.get).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ timeout: 5000, signal: expect.any(AbortSignal) }),
		);
	});

	it("contains a failed sound load and can retry without affecting the preference", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("offline"));
		sound.enabled = true;
		await expect(sound.play("pop")).resolves.toBeUndefined();
		expect(warning).toHaveBeenCalledWith("Sound effects unavailable:", expect.any(Error));
		expect(createBufferSource).not.toHaveBeenCalled();
		expect(sound.enabled).toBe(true);
		await sound.play("pop");
		expect(createBufferSource).toHaveBeenCalledOnce();
	});
});
