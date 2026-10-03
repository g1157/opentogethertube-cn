<template>
	<v-list-item
		v-if="captions.isCaptionsEnabled.value"
		link
		@click="disable"
		data-cy="subtitle-off"
	>
		{{ $t("room.subtitle-off") }}
	</v-list-item>
	<v-list-item
		v-for="(track, idx) in captions.captionsTracks.value"
		:key="idx"
		link
		:active="isTrackActive(idx)"
		@click="select(idx)"
		:data-cy="`subtitle-${idx}`"
	>
		{{ formatCaption(track) }}
	</v-list-item>
</template>

<script lang="ts" setup>
import { useI18n } from "vue-i18n";
import { useCaptions } from "../composables";
import type { CaptionTrack } from "@/models/media-tracks";

const emit = defineEmits<{ select: [] }>();

const { t } = useI18n();
const captions = useCaptions();

function formatCaption(track: CaptionTrack | undefined): string {
	if (!track) {
		return t("player.settings.unknown");
	}
	const localizedLabel =
		track.srclang &&
		new Intl.DisplayNames([track.srclang], { type: "language", fallback: "none" }).of(
			track.srclang,
		);
	const label = track.label ?? localizedLabel ?? track.srclang ?? t("player.settings.unknown");
	return label;
}

function isTrackActive(idx: number): boolean {
	return captions.isCaptionsEnabled.value && idx === captions.currentTrack.value;
}

function select(idx: number): void {
	if (!captions.isCaptionsEnabled.value) {
		captions.isCaptionsEnabled.value = true;
	}
	captions.currentTrack.value = idx;
	emit("select");
}

function disable(): void {
	captions.isCaptionsEnabled.value = false;
	emit("select");
}
</script>
