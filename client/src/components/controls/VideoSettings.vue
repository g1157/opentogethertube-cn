<template>
	<!-- Phones in portrait get a bottom sheet: the anchored menu opened upward over the
	     picture, so adjusting a setting cost you sight of what you were adjusting. The sheet
	     leaves the video visible above it; desktop and fullscreen keep the anchored menu. -->
	<component
		:is="asSheet ? 'v-bottom-sheet' : 'v-menu'"
		ref="menu"
		v-model="isMenuOpen"
		v-bind="asSheet ? sheetProps : menuProps"
		:content-class="
			asSheet ? 'player-settings-overlay player-settings-sheet' : 'player-settings-overlay'
		"
	>
		<template v-if="!asSheet" #activator="{ props: activatorProps }">
			<v-btn
				v-bind="activatorProps"
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
						<v-list-item v-if="compact">
							<div class="compact-playback-options">
								<VolumeControl />
								<PlaybackRateSwitcher />
							</div>
						</v-list-item>
						<v-list-item
							v-if="compact"
							link
							class="menu-item"
							:disabled="!isQualitySupported"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiTune"
							@click="navigateToMenu('quality')"
							data-cy="player-quality-toggle"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.quality") }}</span>
								<span class="menu-item-value">
									{{ currentQualityDisplay }}
								</span>
							</div>
						</v-list-item>
						<v-list-item
							v-if="compact"
							link
							class="menu-item"
							:disabled="!isCaptionsSupported"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiClosedCaptionOutline"
							@click="navigateToMenu('subtitle')"
							data-cy="player-subtitle-toggle"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.subtitles") }}</span>
								<span v-if="currentSubtitleDisplay" class="menu-item-value">
									{{ currentSubtitleDisplay }}
								</span>
							</div>
						</v-list-item>
						<v-list-item
							v-if="compact"
							link
							class="menu-item"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiCommentMultipleOutline"
							@click="navigateToMenu('danmaku')"
							data-cy="player-danmaku-toggle"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.danmaku.title") }}</span>
								<span class="menu-item-value">{{ danmakuLabel }}</span>
							</div>
						</v-list-item>
						<v-list-item
							link
							class="menu-item"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiAutoFix"
							@click="navigateToMenu('upscale')"
							data-cy="player-upscale-toggle"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.upscale.title") }}</span>
								<span class="menu-item-value">{{ upscaleLabel }}</span>
							</div>
						</v-list-item>
						<v-list-item
							link
							class="menu-item"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiMusicNote"
							@click="navigateToMenu('audio')"
							data-cy="player-audio-toggle"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.audio.title") }}</span>
								<span class="menu-item-value">{{ audioLabel }}</span>
							</div>
						</v-list-item>
						<v-list-item
							link
							class="menu-item"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiAspectRatio"
							@click="navigateToMenu('display')"
							data-cy="player-display-toggle"
						>
							<div class="menu-item-content">
								<span>{{ $t("room.display.title") }}</span>
								<span class="menu-item-value">{{ displayLabel }}</span>
							</div>
						</v-list-item>
						<v-divider class="menu-divider" />
						<v-list-item
							link
							class="menu-item"
							:append-icon="mdiChevronRight"
							:prepend-icon="mdiDotsHorizontal"
							@click="navigateToMenu('more')"
							data-cy="player-more-toggle"
						>
							{{ $t("room.more-settings") }}
						</v-list-item>
					</v-list>

					<!-- Everything that is set once and left alone -->
					<v-list v-else-if="currentMenu === 'more'" key="more" class="menu-content">
						<v-list-item
							link
							class="menu-header"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.more-settings") }}
						</v-list-item>
						<v-list-item>
							<v-list-item-title>{{
								$t("player.interactions.seek-step")
							}}</v-list-item-title>
							<v-btn-toggle
								v-model="seekSeconds"
								mandatory
								density="compact"
								color="primary"
								class="seek-step-options"
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
						<v-list-item link :prepend-icon="mdiInformationOutline" @click="showStats">
							{{ $t("player.stats.title") }}
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
							<v-checkbox
								v-model="sfxEnabled"
								:label="$t('client-settings.sfx-enable')"
								:hint="$t('client-settings.sfx-hint')"
								persistent-hint
								density="compact"
								data-cy="chat-sound-enabled"
							/>
						</v-list-item>
						<v-list-item class="preference-row">
							<v-list-item-title>{{
								$t("client-settings.chat-overlay-duration")
							}}</v-list-item-title>
							<v-btn-toggle
								v-model="chatOverlaySeconds"
								mandatory
								density="compact"
								color="primary"
								class="preference-chips"
								data-cy="chat-overlay-duration"
							>
								<v-btn
									v-for="seconds in CHAT_OVERLAY_SECONDS_OPTIONS"
									:key="seconds"
									:value="seconds"
									size="x-small"
								>
									{{ secondsLabel(seconds) }}
								</v-btn>
							</v-btn-toggle>
							<div class="preference-hint">
								{{ $t("client-settings.chat-overlay-hint") }}
							</div>
						</v-list-item>
						<v-list-item class="preference-row">
							<v-list-item-title>{{
								$t("client-settings.controls-hide-delay")
							}}</v-list-item-title>
							<v-btn-toggle
								v-model="controlsHideSeconds"
								mandatory
								density="compact"
								color="primary"
								class="preference-chips"
								data-cy="controls-hide-delay"
							>
								<v-btn
									v-for="value in CONTROLS_HIDE_SECONDS_OPTIONS"
									:key="value"
									:value="value"
									size="x-small"
								>
									{{ secondsLabel(value) }}
								</v-btn>
							</v-btn-toggle>
							<div class="preference-hint">
								{{ $t("client-settings.controls-hide-hint") }}
							</div>
						</v-list-item>
						<v-list-item class="preference-row">
							<v-list-item-title>{{
								$t("client-settings.hls-buffer-duration")
							}}</v-list-item-title>
							<v-btn-toggle
								v-model="hlsBufferSeconds"
								mandatory
								density="compact"
								color="primary"
								class="preference-chips"
								data-cy="hls-buffer-duration"
							>
								<v-btn
									v-for="value in HLS_BUFFER_SECONDS_OPTIONS"
									:key="value"
									:value="value"
									size="x-small"
								>
									{{ secondsLabel(value) }}
								</v-btn>
							</v-btn-toggle>
							<div class="preference-hint">
								{{ $t("client-settings.hls-buffer-hint") }}
							</div>
						</v-list-item>
						<v-list-item
							v-for="notice in roomNotices"
							:key="notice.setting"
							class="preference-row"
						>
							<v-list-item-title>
								{{ $t(`client-settings.${notice.label}`) }}
							</v-list-item-title>
							<v-btn-toggle
								:model-value="store.state.settings[notice.setting]"
								@update:model-value="
									value =>
										store.commit('settings/UPDATE', { [notice.setting]: value })
								"
								mandatory
								density="compact"
								color="primary"
								class="preference-chips"
								:data-cy="notice.label"
							>
								<v-btn
									v-for="seconds in ROOM_NOTICE_SECONDS_OPTIONS"
									:key="seconds"
									:value="seconds"
									size="x-small"
								>
									{{ secondsLabel(seconds) }}
								</v-btn>
							</v-btn-toggle>
							<div class="preference-hint">
								{{ $t("client-settings.room-notice-hint") }}
							</div>
						</v-list-item>
					</v-list>

					<!-- Quality submenu; desktop reaches the same list from the control bar. -->
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

						<QualityMenuPanel @select="closeMenu" />
					</v-list>

					<!-- Audio submenu -->
					<v-list
						v-else-if="currentMenu === 'audio'"
						key="audio"
						class="menu-content"
						color="primary"
					>
						<v-list-item
							link
							class="menu-header"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.audio.title") }}
						</v-list-item>
						<template v-if="!audioEqBrowserSupported">
							<v-list-item>
								<v-list-item-title class="settings-unavailable">
									{{ $t("room.audio.browser-unsupported") }}
								</v-list-item-title>
							</v-list-item>
						</template>
						<template v-else-if="audioEqSupported">
							<v-list-item v-if="audioEqBlocked">
								<v-list-item-title class="settings-unavailable">
									{{ $t("room.audio.blocked") }}
								</v-list-item-title>
							</v-list-item>
							<v-list-item
								v-for="option in audioEqOptions"
								:key="option.value"
								link
								:active="store.state.settings.audioEqPreset === option.value"
								:data-cy="`audio-eq-${option.value}`"
								@click="selectAudioEq(option.value)"
							>
								{{ option.text }}
							</v-list-item>
							<v-list-item>
								<v-list-item-subtitle class="settings-note">
									{{ $t("room.audio.hint") }}
								</v-list-item-subtitle>
							</v-list-item>
						</template>
						<v-list-item v-else>
							<v-list-item-title class="settings-unavailable">
								{{ $t("room.audio.unavailable") }}
							</v-list-item-title>
						</v-list-item>
					</v-list>

					<!-- Display submenu -->
					<v-list
						v-else-if="currentMenu === 'display'"
						key="display"
						class="menu-content"
						color="primary"
					>
						<v-list-item
							link
							class="menu-header"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.display.title") }}
						</v-list-item>
						<template v-if="nativeSurfaceSupported">
							<v-list-item
								v-for="option in fillModeOptions"
								:key="option.value"
								link
								:active="videoFillMode === option.value"
								:data-cy="`video-fill-${option.value}`"
								@click="selectFillMode(option.value)"
							>
								{{ option.text }}
							</v-list-item>
							<v-list-item>
								<v-checkbox
									v-model="videoMirror"
									:label="$t('room.display.mirror')"
									density="compact"
									hide-details
									data-cy="video-mirror"
								/>
							</v-list-item>
							<v-list-item>
								<v-list-item-subtitle class="settings-note">
									{{ $t("room.display.hint") }}
								</v-list-item-subtitle>
							</v-list-item>
						</template>
						<v-list-item v-else>
							<v-list-item-title class="settings-unavailable">
								{{ $t("room.display.unavailable") }}
							</v-list-item-title>
						</v-list-item>
					</v-list>

					<!-- Subtitle submenu; desktop reaches the same list from the control bar. -->
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

						<SubtitleMenuPanel @select="closeMenu" />
					</v-list>

					<!-- Video enhancement submenu -->
					<v-list
						v-else-if="currentMenu === 'upscale'"
						key="upscale"
						class="menu-content"
						color="primary"
					>
						<v-list-item
							link
							class="menu-header"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.upscale.title") }}
							<template #append>
								<!-- The tiers explain themselves on hover. A tap opens the same
								     popover, but hover must be off there: on touch a tap fires a
								     synthetic mouseenter (open) and then the click (close), which
								     left it looking dead. -->
								<v-menu
									:attach="preferenceMenuProps.attach"
									:open-on-hover="hoverToOpen"
									:open-delay="120"
									:close-delay="150"
									:close-on-content-click="false"
									location="bottom end"
									:offset="6"
									:max-width="300"
									content-class="upscale-help-popover"
								>
									<template #activator="{ props: helpProps }">
										<v-btn
											v-bind="helpProps"
											icon
											size="x-small"
											variant="text"
											data-cy="upscale-help"
											:aria-label="$t('room.upscale.help')"
											@click.stop
										>
											<v-icon :icon="mdiInformationOutline" size="small" />
										</v-btn>
									</template>
									<div class="upscale-help">
										<p>{{ $t("room.upscale.intro-sharpen") }}</p>
										<p>{{ $t("room.upscale.intro-film") }}</p>
										<p v-if="webgpuAvailable">
											{{ $t("room.upscale.intro-anime4k") }}
										</p>
										<p v-if="webgpuAvailable">
											{{ $t("room.upscale.intro-anime4k-quality") }}
										</p>
										<p v-if="!webgpuAvailable">
											{{ $t("room.upscale.intro-anime4k-ultra") }}
										</p>
										<p class="upscale-help-note">
											{{ $t("room.upscale.intro-note") }}
										</p>
									</div>
								</v-menu>
							</template>
						</v-list-item>

						<v-list-item class="upscale-tiers-item">
							<v-btn-toggle
								v-model="upscaleMode"
								mandatory
								density="compact"
								color="primary"
								class="upscale-tiers"
								data-cy="upscale-tiers"
							>
								<v-btn
									v-for="option in upscaleOptions"
									:key="option.value"
									:value="option.value"
									size="small"
									:data-cy="`upscale-tier-${option.value}`"
								>
									{{ option.text }}
								</v-btn>
							</v-btn-toggle>
						</v-list-item>

						<v-list-item class="upscale-advanced-label">
							<v-list-item-title class="upscale-section-title">
								{{ $t("room.upscale.advanced") }}
							</v-list-item-title>
						</v-list-item>

						<v-list-item>
							<v-slider
								v-model="upscaleStrength"
								:label="$t('room.upscale.strength')"
								:min="MIN_UPSCALE_STRENGTH"
								:max="MAX_UPSCALE_STRENGTH"
								:step="0.05"
								:disabled="!SLIDER_STRENGTH_MODES.includes(upscaleMode)"
								density="compact"
								thumb-label
								data-cy="upscale-strength"
							/>
						</v-list-item>
						<v-list-item>
							<v-select
								v-model="upscaleScale"
								:label="$t('room.upscale.scale')"
								:hint="$t('room.upscale.scale-hint')"
								:items="upscaleScaleOptions"
								:menu-props="preferenceMenuProps"
								persistent-hint
								density="compact"
								class="my-2"
								data-cy="upscale-scale"
							/>
						</v-list-item>
						<v-list-item>
							<v-checkbox
								v-model="upscaleAutoDegrade"
								:label="$t('room.upscale.auto-degrade')"
								:hint="$t('room.upscale.auto-degrade-hint')"
								persistent-hint
								density="compact"
								data-cy="upscale-auto-degrade"
							/>
						</v-list-item>
					</v-list>

					<!-- Bullet comment submenu; desktop reaches the same panel from the
					     control bar, next to the danmaku toggle. -->
					<v-list
						v-else-if="currentMenu === 'danmaku'"
						key="danmaku"
						class="menu-content"
						color="primary"
					>
						<v-list-item
							link
							class="menu-header"
							:prepend-icon="mdiChevronLeft"
							@click="navigateToMenu('main')"
						>
							{{ $t("room.danmaku.title") }}
						</v-list-item>
						<DanmakuSettingsPanel />
					</v-list>
				</div>
			</div>
		</v-container>
	</component>
	<v-btn
		v-if="asSheet"
		variant="text"
		icon
		class="media-control"
		data-cy="player-settings-toggle"
		:aria-label="$t('room.player-settings')"
		@click="isMenuOpen = !isMenuOpen"
	>
		<v-icon :icon="mdiCog" />
		<v-tooltip activator="parent" location="top" :disabled="!canHover || isMenuOpen">
			{{ $t("room.player-settings") }}
		</v-tooltip>
	</v-btn>
</template>

<script lang="ts" setup>
import { ref, computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
import {
	audioEqSourceBlocked,
	useCaptions,
	useDanmaku,
	useMediaPlayer,
	useQualities,
} from "../composables";
import type { MediaPlayer, MediaPlayerWithAudioBoost } from "../composables";
import {
	mdiCog,
	mdiAutoFix,
	mdiAspectRatio,
	mdiClosedCaptionOutline,
	mdiDotsHorizontal,
	mdiMusicNote,
	mdiTune,
	mdiChevronLeft,
	mdiChevronRight,
	mdiKeyboardOutline,
	mdiInformationOutline,
	mdiCommentMultipleOutline,
} from "@mdi/js";
import { getFriendlyResolutionLabel } from "@/util/misc";
import { qualityTierFromHeight } from "@/util/quality-display";
import { elementAudioRoutingSupported } from "@/util/audio-eq";
import type { VideoTrack, CaptionTrack } from "@/models/media-tracks";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import { usePlayerControlsActivity } from "@/util/player-controls";
import { useStore } from "@/store";
import {
	AUDIO_EQ_PRESETS,
	CHAT_OVERLAY_SECONDS_OPTIONS,
	CONTROLS_HIDE_SECONDS_OPTIONS,
	HLS_BUFFER_SECONDS_OPTIONS,
	MAX_UPSCALE_STRENGTH,
	MIN_UPSCALE_STRENGTH,
	ROOM_NOTICE_SECONDS_OPTIONS,
	UPSCALE_MODES,
	UPSCALE_SCALES,
	VIDEO_FILL_MODES,
	type AudioEqPreset,
	type VideoFillMode,
} from "@/stores/settings";
import { canRunWebGPUEnhancement, webgpuVideoUploadSupported } from "@/util/upscale/webgpu-probe";
import VolumeControl from "./VolumeControl.vue";
import PlaybackRateSwitcher from "./PlaybackRateSwitcher.vue";
import DanmakuSettingsPanel from "./DanmakuSettingsPanel.vue";
import QualityMenuPanel from "./QualityMenuPanel.vue";
import SubtitleMenuPanel from "./SubtitleMenuPanel.vue";

const props = defineProps<{ compact?: boolean }>();
const emit = defineEmits(["show-shortcuts", "show-stats"]);
const store = useStore();
const { t } = useI18n();

/** Hover-open only where a pointer can actually hover; touch taps must toggle on click. */
const hoverToOpen =
	typeof window !== "undefined" &&
	typeof window.matchMedia === "function" &&
	!window.matchMedia("(pointer: coarse)").matches;

type UpscaleMode = (typeof UPSCALE_MODES)[number];
// Which tiers to offer follows from a real probe of the WebGPU path, not from the interface
// existing: Firefox exposes navigator.gpu everywhere but hands out no adapter outside Windows and
// Nightly, and where it does hand one out its WebGPU still cannot upload a video frame — so the
// AI tiers fall back to the WebGL2 chain, whose heavy A+A (HQ) tier then takes the place of the
// WebGPU "quality" one. That upload answer is only known once a video has been through the probe,
// so this recomputes when it arrives.
const webgpuCoreAvailable = ref(false);
const webgpuAvailable = computed(
	() => webgpuCoreAvailable.value && webgpuVideoUploadSupported.value !== false,
);
void canRunWebGPUEnhancement().then(usable => {
	webgpuCoreAvailable.value = usable;
});
const upscaleLabel = computed(() => t(`room.upscale.${store.state.settings.upscaleMode}`));
const upscaleOptions = computed(() => {
	const options: Array<{ value: UpscaleMode; text: string }> = [
		{ value: "off", text: t("room.upscale.off") },
		{ value: "sharpen", text: t("room.upscale.sharpen") },
		{ value: "film", text: t("room.upscale.film") },
	];
	if (webgpuAvailable.value) {
		options.push({ value: "anime4k", text: t("room.upscale.anime4k") });
		options.push({ value: "anime4k-quality", text: t("room.upscale.anime4k-quality") });
	} else {
		options.push({ value: "anime4k", text: t("room.upscale.anime4k") });
		if (!window.matchMedia("(pointer: coarse)").matches) {
			// The heavy chain is a desktop affair: about 55 passes per frame.
			options.push({ value: "anime4k-ultra", text: t("room.upscale.anime4k-ultra") });
		}
	}
	return options;
});
/** The tiers whose shader actually reads `upscaleStrength`; the CNN tiers replace it wholesale. */
const SLIDER_STRENGTH_MODES: UpscaleMode[] = ["sharpen", "film"];
const upscaleMode = computed({
	get: () => store.state.settings.upscaleMode as UpscaleMode,
	set: value => store.commit("settings/UPDATE", { upscaleMode: value }),
});
const upscaleStrength = computed({
	get: () => store.state.settings.upscaleStrength,
	set: value => store.commit("settings/UPDATE", { upscaleStrength: value }),
});
const upscaleScale = computed({
	get: () => store.state.settings.upscaleScale,
	set: value => store.commit("settings/UPDATE", { upscaleScale: value }),
});
const upscaleAutoDegrade = computed({
	get: () => store.state.settings.upscaleAutoDegrade,
	set: value => store.commit("settings/UPDATE", { upscaleAutoDegrade: value }),
});
const upscaleScaleOptions = computed(() =>
	UPSCALE_SCALES.map(option => ({
		// biome-ignore lint/nursery/noVueRefAsOperand: map iterates plain scale values, not Vue refs.
		title: option === "auto" ? t("room.upscale.scale-auto") : `${option}×`,
		value: option,
	})),
);
const danmaku = useDanmaku();
const danmakuAvailable = computed(() => danmaku.available.value);
const danmakuLabel = computed(() => {
	if (!danmakuAvailable.value) {
		return t("player.settings.disabled");
	}
	return store.state.settings.danmakuEnabled ? t("common.on") : t("common.off");
});
const controls = useMediaPlayer();

function implementsAudioBoost(p: MediaPlayer | null): p is MediaPlayerWithAudioBoost {
	return !!p && "setAudioBoost" in p;
}

/** WebKit would stutter on attached element audio; the feature stays off there. */
const audioEqBrowserSupported = elementAudioRoutingSupported();

/** Sound shaping and picture fitting need the media element; iframe players have none. */
const nativeSurfaceSupported = computed(
	() =>
		controls.checkForPlayer(controls.player.value) &&
		implementsAudioBoost(controls.player.value),
);
const audioEqSupported = computed(() => nativeSurfaceSupported.value);
const audioEqBlocked = computed(() => audioEqSourceBlocked.value);
const audioEqOptions = computed(() =>
	AUDIO_EQ_PRESETS.map(preset => ({
		// biome-ignore lint/nursery/noVueRefAsOperand: preset values are plain strings, not Vue refs.
		text: t(`room.audio.${preset}`),
		value: preset,
	})),
);
const audioLabel = computed(() =>
	!audioEqBrowserSupported
		? t("player.settings.disabled")
		: nativeSurfaceSupported.value
		? t(`room.audio.${store.state.settings.audioEqPreset}`)
		: t("player.settings.disabled"),
);

function selectAudioEq(preset: AudioEqPreset): void {
	store.commit("settings/UPDATE", { audioEqPreset: preset });
	closeMenu();
	if (preset === "off") {
		return;
	}
	// The player applies the preset through a watcher; one tick later it has reported
	// whether this source could be routed through Web Audio at all.
	void nextTick().then(() => {
		if (audioEqBlocked.value) {
			toast.add({
				style: ToastStyle.Neutral,
				content: t("room.audio.blocked-toast"),
				duration: 6000,
			});
		}
	});
}

const videoFillMode = computed({
	get: () => store.state.settings.videoFillMode,
	set: value => store.commit("settings/UPDATE", { videoFillMode: value }),
});
const videoMirror = computed({
	get: () => store.state.settings.videoMirror,
	set: value => store.commit("settings/UPDATE", { videoMirror: value }),
});
const fillModeOptions = computed(() =>
	VIDEO_FILL_MODES.map(mode => ({
		// biome-ignore lint/nursery/noVueRefAsOperand: mode values are plain strings, not Vue refs.
		text: t(`room.display.${mode}`),
		value: mode,
	})),
);
const displayLabel = computed(() =>
	nativeSurfaceSupported.value
		? t(`room.display.${videoFillMode.value}`)
		: t("player.settings.disabled"),
);

function selectFillMode(mode: VideoFillMode): void {
	videoFillMode.value = mode;
}
const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
const menu = ref<{ updateLocation?: () => void } | null>(null);
/** Portrait phones: a sheet from the bottom instead of a menu floating over the video. */
const asSheet = computed(() => props.compact === true);
const menuProps = {
	location: "top end",
	origin: "auto",
	offset: 8,
	width: 300,
	minWidth: 0,
	maxWidth: 300,
	maxHeight: 360,
	closeOnContentClick: false,
	scrollStrategy: "reposition" as const,
	transition: "fade-transition",
};
const sheetProps = {
	scrollable: true,
	maxHeight: "52vh",
};
// VMenu resets inherited defaults inside its content, including nested select menus.
const preferenceMenuProps = computed(() => ({
	attach: store.state.fullscreen ? ".player-fullscreen" : false,
}));
const seekSeconds = computed({
	get: () => store.state.settings.seekSeconds,
	set: value => store.commit("settings/UPDATE", { seekSeconds: value }),
});
const sfxEnabled = computed({
	get: () => store.state.settings.sfxEnabled,
	set: value => store.commit("settings/UPDATE", { sfxEnabled: value }),
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
const roomNotices = [
	{ setting: "presenceNoticeSeconds", label: "presence-notice-duration" },
	{ setting: "seekNoticeSeconds", label: "seek-notice-duration" },
] as const;

/** One label style for every duration chip row. */
function secondsLabel(seconds: number): string {
	return seconds > 0 ? t("player.interactions.seconds", { count: seconds }) : t("common.off");
}

// Menu types - using literal string values instead of enum due to Safari compatibility issues
const currentMenu = ref<
	| "main"
	| "more"
	| "quality"
	| "subtitle"
	| "preferences"
	| "upscale"
	| "danmaku"
	| "audio"
	| "display"
>("main");
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
		menu.value?.updateLocation?.();
	}
});
// Fullscreen changes the overlay's containing block. Reopen using its new attachment.
watch(() => [store.state.fullscreen, store.state.settings.roomLayout], closeMenu);

function showShortcuts() {
	closeMenu();
	emit("show-shortcuts");
}

function showStats() {
	closeMenu();
	emit("show-stats");
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
	return isEnabled ? formatCaption(track) : t("player.settings.disabled");
});

function formatCaption(track: CaptionTrack): string {
	const localiedLabel =
		track.srclang &&
		new Intl.DisplayNames([track.srclang], { type: "language", fallback: "none" }).of(
			track.srclang,
		);
	const label = track.label ?? localiedLabel ?? track.srclang ?? t("player.settings.unknown");
	return label;
}

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

const currentQualityDisplay = computed(() => {
	if (!isQualitySupported.value) {
		return t("player.settings.disabled");
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

function navigateToMenu(menu): void {
	currentMenu.value = menu;
}

function closeMenu(): void {
	isMenuOpen.value = false;
	currentMenu.value = "main";
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.settings-menu-container {
	background: media-controls.$menu-background;
	border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
	border-radius: media-controls.$menu-radius;
	padding: 0;
	width: 100%;
	min-height: 0;
	max-height: inherit;
	box-shadow: 0 4px 20px rgba(var(--v-theme-surface), 0.3);
	overflow-y: auto;
	overscroll-behavior: contain;
}

/* The phone sheet hugs the bottom edge, so its panel squares off there. */
.player-settings-sheet .settings-menu-container {
	border-radius: 14px 14px 0 0;
	border-bottom: 0;
}

.menu-divider {
	margin: 4px 0;
	opacity: 0.5;
}

.seek-step-options {
	margin: 6px 0;
}

.preference-row {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	padding-top: 4px;
	padding-bottom: 4px;
}

.preference-chips {
	flex-wrap: wrap;
	margin-top: 4px;

	.v-btn {
		min-width: 0;
		padding: 0 6px;
		font-size: 0.72rem;
		text-transform: none;
	}
}

.preference-hint {
	font-size: 0.72rem;
	opacity: 0.6;
	line-height: 1.4;
	margin-top: 2px;
	white-space: normal;
}

.compact-playback-options {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 0;
}

.menu-container {
	border-radius: 10px;
	overflow: hidden;
}

.menu-content {
	width: 100%;
	min-height: fit-content;
	background: transparent;

	/* The menus are the densest surface in the app: rows keep their labels and values on
	   one line, so they can be shorter than Vuetify's defaults without losing anything. */
	.v-list-item {
		min-height: 34px;
	}
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

/*
 * The tiers share one row: each button takes an equal share and wraps its own
 * label ("AI 超分（质量）" breaks after the tier name) rather than truncating it,
 * which is why the row stays legible at the menu's 320px width.
 */
.upscale-tiers {
	display: flex;
	width: 100%;
	/* Vuetify's compact density pins the group to a fixed 36px with overflow-y: hidden, while the
	   buttons below are min-height 40px and their labels wrap, so the row used to clip them. */
	height: auto !important;

	.v-btn {
		flex: 1 1 0;
		min-width: 0;
		height: auto;
		min-height: 40px;
		padding: 4px 6px;
		text-transform: none;
	}

	/* Vuetify keeps the label on one line inside the content wrapper; letting it
	   wrap there is what keeps the four tiers inside the 320px menu. */
	.v-btn__content {
		white-space: normal;
		text-align: center;
		font-size: 0.72rem;
		line-height: 1.25;
	}
}

.upscale-tiers-item,
.upscale-advanced-label {
	min-height: 0;
	padding-top: 4px;
	padding-bottom: 0;
}

.danmaku-advanced-label {
	min-height: 0;
	padding-top: 4px;
	padding-bottom: 0;
}

.danmaku-section-title {
	font-size: 0.75rem;
	font-weight: 500;
	letter-spacing: 0.04em;
	opacity: 0.6;
}

.danmaku-unavailable {
	font-size: 0.8rem;
	opacity: 0.7;
	padding: 4px 0;
}

.settings-unavailable {
	font-size: 0.8rem;
	opacity: 0.7;
	padding: 4px 0;
}

.settings-note {
	font-size: 0.75rem;
	line-height: 1.5;
	opacity: 0.6;
	white-space: normal;
	padding: 4px 0;
}

.upscale-section-title {
	font-size: 0.75rem;
	font-weight: 500;
	letter-spacing: 0.04em;
	opacity: 0.6;
}

/* Menus in this app draw their own surface (the default overlay content is
   transparent), and this popover sits on top of the settings menu, so it needs an
   opaque one plus a border to stay readable. */
.upscale-help-popover {
	background: rgb(var(--v-theme-surface));
	border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
	border-radius: media-controls.$menu-radius;
	box-shadow: 0 6px 20px rgb(0 0 0 / 35%);
}

.upscale-help {
	padding: 12px 14px;

	p {
		margin: 0 0 8px;
		font-size: 0.8rem;
		line-height: 1.6;
		opacity: 0.85;
	}

	.upscale-help-note {
		margin-bottom: 0;
		opacity: 0.6;
	}
}
</style>
