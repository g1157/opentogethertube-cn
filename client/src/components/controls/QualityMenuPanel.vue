<template>
	<v-list-item
		v-if="qualities.isAutoQualitySupported.value"
		link
		:active="isAutoQualityActive"
		@click="select(-1)"
		data-cy="quality-auto"
	>
		{{ autoQualityDisplay }}
	</v-list-item>
	<v-list-item
		v-for="(quality, idx) in qualities.videoTracks.value"
		:key="idx"
		link
		:active="idx === qualities.currentVideoTrack.value"
		@click="select(idx)"
		:data-cy="`quality-${idx}`"
	>
		{{ formatQuality(quality) }}
	</v-list-item>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useQualities } from "../composables";
import { getFriendlyResolutionLabel } from "@/util/misc";
import { qualityTierFromHeight } from "@/util/quality-display";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import type { VideoTrack } from "@/models/media-tracks";

const emit = defineEmits<{ select: [] }>();

const { t } = useI18n();
const qualities = useQualities();

function formatQuality(videoTrack: VideoTrack): string {
	const resolution = videoTrack.label ?? getFriendlyResolutionLabel(videoTrack);
	const resolutionText = `${resolution}p`;
	const tier = qualityTierFromHeight(videoTrack.height);
	if (!tier) {
		return resolutionText;
	}
	return `${t(`player.settings.quality-tiers.${tier}`)} · ${resolutionText}`;
}

const autoQualityDisplay = computed(() => {
	const hasActiveQuality =
		qualities.currentVideoTrack.value === -1 &&
		qualities.videoTracks.value.length > 0 &&
		qualities.currentActiveQuality.value !== null;

	const currentQuality = qualities.videoTracks.value[qualities.currentActiveQuality.value!];
	return hasActiveQuality
		? t("player.settings.auto-with-value", { value: formatQuality(currentQuality) })
		: t("player.settings.auto");
});

const isAutoQualityActive = computed(() => qualities.currentVideoTrack.value === -1);

function select(idx: number): void {
	qualities.currentVideoTrack.value = idx;
	const track = idx >= 0 ? qualities.videoTracks.value[idx] : undefined;
	toast.add({
		style: ToastStyle.Neutral,
		content: t("player.settings.quality-switching", {
			quality: track ? formatQuality(track) : t("player.settings.auto"),
		}),
		duration: 5000,
	});
	emit("select");
}
</script>
