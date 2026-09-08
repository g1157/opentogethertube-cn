<template>
	<v-menu
		ref="menu"
		v-model="isMenuOpen"
		location="top end"
		origin="auto"
		:offset="8"
		:width="320"
		:min-width="0"
		:max-width="320"
		:max-height="420"
		:close-on-content-click="false"
		scroll-strategy="reposition"
		transition="fade-transition"
		content-class="player-settings-overlay"
	>
		<template #activator="{ props }">
			<v-btn
				v-bind="props"
				variant="text"
				icon
				class="media-control"
				data-cy="player-settings-toggle"
				:aria-label="$t('room.player-settings')"
			>
				<v-icon :icon="mdiCog" />
				<v-tooltip activator="parent" location="top" :disabled="!canHover || isMenuOpen">
					{{ $t("room.player-settings") }}
				</v-tooltip>
			</v-btn>
		</template>

		<v-container v-if="isMenuOpen" class="settings-menu-container" data-player-shortcuts="off">
			<div class="menu-container">
				<div>
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
						<v-list-item
							link
							class="menu-item"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiTune"
							@click="navigateToMenu('preferences')"
							data-cy="player-preferences-toggle"
						>
							{{ $t("client-settings.playback-preferences") }}
						</v-list-item>
						<v-list-item link :prepend-icon="mdiKeyboardOutline" @click="showShortcuts">
							{{ $t("player.shortcuts.title") }}
						</v-list-item>
					</v-list>

					<v-list
						v-else-if="currentMenu === 'preferences'"
						key="preferences"
						class="menu-content"
					>
						<v-list-item
							link
							class="menu-header"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("client-settings.playback-preferences") }}
						</v-list-item>
						<v-list-item>
							<v-select
								v-model="chatOverlaySeconds"
								:label="$t('client-settings.chat-overlay-duration')"
								:hint="$t('client-settings.chat-overlay-hint')"
								:items="chatOverlayOptions"
								:menu-props="preferenceMenuProps"
								persistent-hint
								density="compact"
								class="my-2"
								data-cy="chat-overlay-duration"
							/>
						</v-list-item>
						<v-list-item>
							<v-select
								v-model="controlsHideSeconds"
								:label="$t('client-settings.controls-hide-delay')"
								:hint="$t('client-settings.controls-hide-hint')"
								:items="controlsHideOptions"
								:menu-props="preferenceMenuProps"
								persistent-hint
								density="compact"
								class="my-2"
								data-cy="controls-hide-delay"
							/>
						</v-list-item>
						<v-list-item>
							<v-select
								v-model="hlsBufferSeconds"
								:label="$t('client-settings.hls-buffer-duration')"
								:hint="$t('client-settings.hls-buffer-hint')"
								:items="hlsBufferOptions"
								:menu-props="preferenceMenuProps"
								persistent-hint
								density="compact"
								class="my-2"
								data-cy="hls-buffer-duration"
							/>
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
				</div>
			</div>
		</v-container>
	</v-menu>
</template>

<script lang="ts" setup>
import { ref, computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
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
import {
	CHAT_OVERLAY_SECONDS_OPTIONS,
	CONTROLS_HIDE_SECONDS_OPTIONS,
	HLS_BUFFER_SECONDS_OPTIONS,
} from "@/stores/settings";

const emit = defineEmits(["show-shortcuts"]);
const store = useStore();
const { t } = useI18n();
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
const menu = ref<{ updateLocation: () => void } | null>(null);
// VMenu resets inherited defaults inside its content, including nested select menus.
const preferenceMenuProps = computed(() => ({
	attach: store.state.fullscreen ? ".player-fullscreen" : false,
}));
const swipeSeekSeconds = computed({
	get: () => store.state.settings.swipeSeekSeconds,
	set: value => store.commit("settings/UPDATE", { swipeSeekSeconds: value }),
});
const chatOverlaySeconds = computed({
	get: () => store.state.settings.chatOverlaySeconds,
	set: value => store.commit("settings/UPDATE", { chatOverlaySeconds: value }),
});
const controlsHideSeconds = computed({
	get: () => store.state.settings.controlsHideSeconds,
	set: value => store.commit("settings/UPDATE", { controlsHideSeconds: value }),
});
const hlsBufferSeconds = computed({
	get: () => store.state.settings.hlsBufferSeconds,
	set: value => store.commit("settings/UPDATE", { hlsBufferSeconds: value }),
});
const chatOverlayOptions = computed(() =>
	CHAT_OVERLAY_SECONDS_OPTIONS.map(seconds => ({
		// biome-ignore lint/nursery/noVueRefAsOperand: seconds is a numeric option, not a Vue ref.
		title: seconds > 0 ? t("player.interactions.seconds", { count: seconds }) : t("common.off"),
		value: seconds,
	})),
);
const controlsHideOptions = computed(() =>
	CONTROLS_HIDE_SECONDS_OPTIONS.map(value => ({
		title: t("player.interactions.seconds", { count: value }),
		value,
	})),
);
const hlsBufferOptions = computed(() =>
	HLS_BUFFER_SECONDS_OPTIONS.map(value => ({
		title: t("player.interactions.seconds", { count: value }),
		value,
	})),
);

// Menu types - using literal string values instead of enum due to Safari compatibility issues
const currentMenu = ref<"main" | "quality" | "subtitle" | "preferences">("main");
const isMenuOpen = ref<boolean>(false);
usePlayerControlsActivity(isMenuOpen);

watch(isMenuOpen, open => {
	if (!open) {
		currentMenu.value = "main";
	}
});
watch(currentMenu, async () => {
	await nextTick();
	if (isMenuOpen.value) {
		menu.value?.updateLocation();
	}
});
// Fullscreen changes the overlay's containing block. Reopen using its new attachment.
watch(() => [store.state.fullscreen, store.state.settings.roomLayout], closeMenu);

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

function closeMenu(): void {
	isMenuOpen.value = false;
	currentMenu.value = "main";
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
	background: media-controls.$menu-background;
	border-radius: media-controls.$menu-radius;
	padding: 0;
	width: 100%;
	min-height: 0;
	max-height: inherit;
	box-shadow: 0 4px 20px rgba(var(--v-theme-surface), 0.3);
	overflow-y: auto;
	overscroll-behavior: contain;
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
		min-width: 0;
		font-weight: 500;
	}

	&-value {
		color: rgba(var(--v-theme-on-surface), 0.6);
		font-size: 0.875rem;
		margin-left: 1rem;
		font-weight: 400;
		min-width: 0;
		max-width: 55%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
}

.menu-header {
	font-weight: 500;
}
</style>
