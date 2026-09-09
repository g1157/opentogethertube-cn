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
		sound.volume.value = 0.23;
		await nextTick();
		expect(gain.gain.value).toBe(0.23);
	});
});
