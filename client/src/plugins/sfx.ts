import { inject, type InjectionKey, type App, type Plugin, ref, type Ref } from "vue";
import axios from "axios";

export const sfxInjectKey: InjectionKey<OttSfx> = Symbol("ott:sfx");

export function useSfx(): OttSfx {
	const sfx = inject(sfxInjectKey);
	if (!sfx) {
		throw new Error("No sfx available, did you forget to install the plugin?");
	}
	return sfx;
}

import sfxPopUrl from "../assets/sfx/pop.ogg?url";
import { watch } from "vue";

/**
 * Handles sound effects.
 */
export class OttSfx {
	enabled: boolean = false;
	volume: Ref<number> = ref(1);
	private loaded: boolean = false;
	private loading: Promise<void> | null = null;

	private assets: Map<string, AudioBuffer> = new Map();
	/**
	 * Created on first use rather than in the field initializers: a page that never plays a
	 * sound should not open an audio device, and an AudioContext built before any user
	 * gesture is also what browsers warn about.
	 */
	private context: AudioContext | null = null;
	private gain: GainNode | null = null;

	constructor() {
		watch(this.volume, () => {
			if (this.gain) {
				this.gain.gain.value = this.volume.value;
			}
		});
	}

	private ensureContext(): { context: AudioContext; gain: GainNode } {
		if (!this.context || !this.gain) {
			const context = new AudioContext();
			const gain = context.createGain();
			gain.gain.value = this.volume.value;
			gain.connect(context.destination);
			this.context = context;
			this.gain = gain;
		}
		return { context: this.context, gain: this.gain };
	}

	async loadSfx() {
		if (this.loaded) {
			return;
		}
		if (this.loading) {
			return this.loading;
		}
		this.loading = this.fetchSfx();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	private async fetchSfx(): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const pop = await axios.get<Blob>(sfxPopUrl, {
				responseType: "blob",
				timeout: 5000,
				signal: controller.signal,
			});
			await this.registerBlob("pop", pop.data);
			this.loaded = true;
		} catch (error) {
			// Optional notification sounds must not reject a room's mount or message handler.
			console.warn("Sound effects unavailable:", error);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async registerBlob(name: string, blob: Blob) {
		const buf = await blob.arrayBuffer();
		const { context } = this.ensureContext();
		const buffer = new Promise<AudioBuffer>((resolve, reject) => {
			context.decodeAudioData(
				buf,
				buffer => {
					resolve(buffer);
				},
				err => {
					console.error("Failed to decode audio data", err);
					reject(err);
				},
			);
		});
		this.assets.set(name, await buffer);
	}

	async play(name: string) {
		if (!this.enabled) {
			return;
		}
		await this.loadSfx();
		if (!this.enabled || !this.loaded) {
			return;
		}
		const asset = this.assets.get(name);
		if (!asset) {
			return;
		}
		try {
			const { context, gain } = this.ensureContext();
			if (context.state === "suspended") {
				// The browser may require a user gesture before it can play a notification.
				await context.resume().catch(() => undefined);
			}
			const source = context.createBufferSource();
			source.buffer = asset;
			source.connect(gain);
			source.start(0);
		} catch (error) {
			console.warn("Sound effects unavailable:", error);
		}
	}
}

export const OttSfxPlugin: Plugin = (app: App, _options) => {
	const connection = new OttSfx();
	app.provide(sfxInjectKey, connection);
};
