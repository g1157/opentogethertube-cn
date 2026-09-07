<template>
	<div class="video-settings-wrapper" @keydown.esc.stop.prevent="closeMenu">
		<v-btn
			variant="text"
			icon
			class="media-control"
			:aria-label="$t('room.player-settings')"
			@click="toggleMenu"
		>
			<v-icon :icon="mdiCog" />
			<v-tooltip activator="parent" location="bottom">
				{{ $t("room.player-settings") }}
			</v-tooltip>
		</v-btn>

		<v-container
			v-if="isMenuOpen"
			v-click-outside="closeMenu"
			class="settings-menu-container"
			data-player-shortcuts="off"
		>
			<div class="menu-container">
				<transition name="menu-resize" mode="out-in" slim>
					<!-- Found the following hack in Room.vue -->
					<!-- HACK: For some reason, safari really doesn't like typescript enums. As a result, we are forced to not use the enums, and use their literal values instead. -->
					<!-- Main menu -->
					<v-list v-if="currentMenu === 'main'" key="main" class="menu-content">
						<v-list-item
							link
							class="menu-item"
							:disabled="!isCaptionsSupported"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiClosedCaptionOutline"
							@click="navigateToMenu('subtitle')"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.subtitles") }}</span>
								<span v-if="currentSubtitleDisplay" class="menu-item-value">
									{{ currentSubtitleDisplay }}
								</span>
							</div>
						</v-list-item>

						<v-list-item
							link
							class="menu-item"
							:disabled="!isQualitySupported"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiTune"
							@click="navigateToMenu('quality')"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.quality") }}</span>
								<span class="menu-item-value">
									{{ currentQualityDisplay }}
								</span>
							</div>
						</v-list-item>
						<v-list-item>
							<v-list-item-title>{{
								$t("player.interactions.swipe-step")
							}}</v-list-item-title>
							<v-btn-toggle
								v-model="swipeSeekSeconds"
								mandatory
								density="compact"
								color="primary"
								class="swipe-step-options"
							>
								<v-btn
									v-for="seconds in [5, 10, 30]"
									:key="seconds"
									:value="seconds"
									size="small"
								>
									{{ $t("player.interactions.seconds", { count: seconds }) }}
								</v-btn>
							</v-btn-toggle>
						</v-list-item>
						<v-list-item link :prepend-icon="mdiKeyboardOutline" @click="showShortcuts">
							{{ $t("player.shortcuts.title") }}
						</v-list-item>
					</v-list>

					<!-- Quality submenu -->
					<v-list
						v-else-if="currentMenu === 'quality'"
						key="quality"
						class="menu-content"
						color="primary"
					>
						<v-list-item
							link
							class="menu-header"
							min-width="150px"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.quality") }}
						</v-list-item>

						<v-list-item
							v-if="qualities.isAutoQualitySupported.value"
							link
							:active="isAutoQualityActive"
							@click="selectQuality(-1)"
						>
							{{ autoQualityDisplay }}
						</v-list-item>

						<v-list-item
							v-for="(quality, idx) in qualities.videoTracks.value"
							:key="idx"
							link
							:active="idx === qualities.currentVideoTrack.value"
							@click="selectQuality(idx)"
						>
							{{ formatQuality(quality) }}
						</v-list-item>
					</v-list>

					<!-- Subtitle submenu -->
					<v-list
						v-else-if="currentMenu === 'subtitle'"
						key="subtitle"
						class="menu-content"
						color="primary"
					>
						<v-list-item
							link
							class="menu-header"
							min-width="200px"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.subtitles") }}
						</v-list-item>

						<v-list-item
							v-for="(track, idx) in captions.captionsTracks.value"
							:key="idx"
							link
							:active="isSubtitleTrackActive(idx)"
							:append-icon="track.kind === 'captions' ? mdiClosedCaption : undefined"
							@click="selectSubtitleTrack(idx)"
						>
							{{ formatCaption(track) }}
						</v-list-item>
					</v-list>
				</transition>
			</div>
		</v-container>
	</div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useCaptions, useQualities } from "../composables";
import {
	mdiCog,
	mdiClosedCaptionOutline,
	mdiClosedCaption,
	mdiTune,
	mdiChevronLeft,
	mdiChevronRight,
	mdiKeyboardOutline,
} from "@mdi/js";
import { getFriendlyResolutionLabel } from "@/util/misc";
import type { VideoTrack, CaptionTrack } from "@/models/media-tracks";
import { usePlayerControlsActivity } from "@/util/player-controls";
import { useStore } from "@/store";

const emit = defineEmits(["show-shortcuts"]);
const store = useStore();
const swipeSeekSeconds = computed({
	get: () => store.state.settings.swipeSeekSeconds,
	set: value => store.commit("settings/UPDATE", { swipeSeekSeconds: value }),
});

// Menu types - using literal string values instead of enum due to Safari compatibility issues
const currentMenu = ref<"main" | "quality" | "subtitle">("main");
const isMenuOpen = ref<boolean>(false);
usePlayerControlsActivity(isMenuOpen);

function onMenuKeyDown(event: KeyboardEvent) {
	if (event.key === "Escape" && isMenuOpen.value && !event.isComposing) {
		event.preventDefault();
		closeMenu();
	}
}
onMounted(() => window.addEventListener("keydown", onMenuKeyDown));
onUnmounted(() => window.removeEventListener("keydown", onMenuKeyDown));

function showShortcuts() {
	closeMenu();
	emit("show-shortcuts");
}

const qualities = useQualities();
const captions = useCaptions();

const isQualitySupported = computed(
	() => qualities.isQualitySupported.value && qualities.videoTracks.value.length > 0,
);

const isCaptionsSupported = computed(
	() => captions.isCaptionsSupported.value && captions.captionsTracks.value.length > 0,
);

const currentSubtitleDisplay = computed(() => {
	const isEnabled =
		isCaptionsSupported.value &&
		captions.isCaptionsEnabled.value &&
		captions.currentTrack.value !== null;
	const track = captions.captionsTracks.value[captions.currentTrack.value || 0];
	return isEnabled ? formatCaption(track) : "disabled";
});

function formatCaption(track: CaptionTrack): string {
	const localiedLabel =
		track.srclang &&
		new Intl.DisplayNames([track.srclang], { type: "language", fallback: "none" }).of(
			track.srclang,
		);
	const label = track.label ?? localiedLabel ?? track.srclang ?? "unknown";
	return label;
}

function formatQuality(videoTrack: VideoTrack): string {
	const resolution = videoTrack.label ?? getFriendlyResolutionLabel(videoTrack);
	return `${resolution}p`;
}

const autoQualityDisplay = computed(() => {
	const hasActiveQuality =
		qualities.currentVideoTrack.value === -1 &&
		qualities.videoTracks.value.length > 0 &&
		qualities.currentActiveQuality.value !== null;

	const currentQuality = qualities.videoTracks.value[qualities.currentActiveQuality.value!];
	return hasActiveQuality ? `Auto (${formatQuality(currentQuality)})` : "Auto";
});

const currentQualityDisplay = computed(() => {
	if (!isQualitySupported.value) {
		return "disabled";
	}

	const isAutoQualitySupported = qualities.isAutoQualitySupported.value;
	const currentTrack = qualities.currentVideoTrack.value;
	if (isAutoQualitySupported && currentTrack === -1) {
		return autoQualityDisplay.value;
	}

	const currentQuality = qualities.videoTracks.value[currentTrack];
	if (currentTrack >= 0 && currentQuality) {
		return formatQuality(currentQuality);
	}

	return "";
});

const isAutoQualityActive = computed(() => qualities.currentVideoTrack.value === -1);

function isSubtitleTrackActive(track: number): boolean {
	return captions.isCaptionsEnabled.value && track === captions.currentTrack.value;
}

function navigateToMenu(menu): void {
	currentMenu.value = menu;
}

function resetToMainMenu(): void {
	currentMenu.value = "main";
}

function toggleMenu(): void {
	isMenuOpen.value = !isMenuOpen.value;
	if (!isMenuOpen.value) {
		resetToMainMenu();
	}
}

function closeMenu(): void {
	isMenuOpen.value = false;
	resetToMainMenu();
}

function selectQuality(idx: number): void {
	qualities.currentVideoTrack.value = idx;
	closeMenu();
}

function selectSubtitleTrack(track: number): void {
	if (!captions.isCaptionsEnabled.value) {
		captions.isCaptionsEnabled.value = true;
	}
	captions.currentTrack.value = track;
	closeMenu();
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.settings-menu-container {
	position: absolute;
	// Anchor to the entire control bar, because the settings button can wrap to another row.
	bottom: calc(100% + 8px);
	right: 8px;
	z-index: 9999;
	background: media-controls.$menu-background;
	border-radius: media-controls.$menu-radius;
	padding: 0;
	width: min(320px, calc(100% - 16px));
	box-shadow: 0 4px 20px rgba(var(--v-theme-surface), 0.3);
	max-height: min(70vh, 420px, calc(100vh - var(--player-controls-height, 90px) - 24px));
	max-height: min(70dvh, 420px, calc(100dvh - var(--player-controls-height, 90px) - 24px));
	overflow-y: auto;
}

.swipe-step-options {
	margin: 8px 0;
}

.menu-container {
	border-radius: 10px;
	overflow: hidden;
}

.menu-content {
	width: 100%;
	min-height: fit-content;
	background: transparent;
}

.menu-item {
	&-content {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		font-weight: 500;
	}

	&-value {
		color: rgba(var(--v-theme-on-surface), 0.6);
		font-size: 0.875rem;
		margin-left: 1rem;
		font-weight: 400;
	}
}

.menu-header {
	font-weight: 500;
}

.menu-resize-enter-active,
.menu-resize-leave-active {
	transition: all 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
	overflow: hidden;
	transform-origin: top center;
}

.menu-resize-enter-active {
	transition-delay: 0.05s;
}

.menu-resize-enter-from,
.menu-resize-leave-to {
	opacity: 0;
	max-height: 0;
	padding-top: 0;
	padding-bottom: 0;
	margin-top: 0;
	margin-bottom: 0;
}

.menu-resize-enter-to,
.menu-resize-leave-from {
	opacity: 1;
	max-height: 500px;
}
</style>
