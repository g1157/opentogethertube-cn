import type { InjectionKey, Ref } from "vue";

export interface PlayerActions {
	playbackBlocked: Readonly<Ref<boolean>>;
	togglePlayback(): void;
	seek(position: number): void;
}

/** Keep native user gestures and room commands in the same playback controller. */
export const PlayerActionsKey: InjectionKey<PlayerActions> = Symbol("player-actions");
