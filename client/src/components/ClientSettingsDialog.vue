<template>
	<v-dialog v-model="show" width="600" scrollable>
		<template v-slot:activator="{ props }">
			<v-btn v-bind="props" style="margin: 0 20px">
				{{ $t("client-settings.activator") }}
			</v-btn>
		</template>
		<v-card>
			<v-card-title>
				{{ $t("client-settings.title") }}
			</v-card-title>
			<v-card-text>
				{{ $t("client-settings.description") }}
			</v-card-text>

			<v-divider />

			<v-card-text>
				<v-select
					:label="$t('client-settings.room-layout')"
					:items="layouts"
					v-model="settings.roomLayout"
				/>
				<v-select
					:label="$t('client-settings.theme')"
					:items="themes"
					v-model="settings.theme"
				>
					<template #item="{ item, props }">
						<v-theme-provider :theme="item.value" with-background>
							<v-list-item v-bind="props" />
						</v-theme-provider>
					</template>
				</v-select>
				<v-select
					v-model="settings.chatOverlaySeconds"
					:label="$t('client-settings.chat-overlay-duration')"
					:hint="$t('client-settings.chat-overlay-hint')"
					:items="chatOverlayOptions"
					persistent-hint
					data-cy="chat-overlay-duration"
				/>
				<v-select
					v-model="settings.controlsHideSeconds"
					:label="$t('client-settings.controls-hide-delay')"
					:hint="$t('client-settings.controls-hide-hint')"
					:items="controlsHideOptions"
					persistent-hint
					data-cy="controls-hide-delay"
				/>
				<v-select
					v-model="settings.hlsBufferSeconds"
					:label="$t('client-settings.hls-buffer-duration')"
					:hint="$t('client-settings.hls-buffer-hint')"
					:items="hlsBufferOptions"
					persistent-hint
					data-cy="hls-buffer-duration"
				/>
				<v-checkbox
					:label="$t('client-settings.sfx-enable')"
					:hint="$t('client-settings.sfx-hint')"
					v-model="settings.sfxEnabled"
					persistent-hint
					data-cy="chat-sound-enabled"
				/>
				<v-slider
					:label="$t('client-settings.audio-boost')"
					:hint="audioBoostHint"
					:disabled="isAudioBoostUnsupported"
					persistent-hint
					v-model="settings.audioBoost"
					min="100"
					max="300"
					step="1"
				>
					<template #append>
						<span class="audio-boost-value">{{ settings.audioBoost }}%</span>
					</template>
				</v-slider>
				<v-slider
					:label="$t('client-settings.sfx-volume')"
					v-model="settings.sfxVolume"
					v-if="settings.sfxEnabled"
					min="0"
					max="1"
					step="0.01"
				/>

				<v-checkbox
					:label="$t('client-settings.room-settings')"
					v-model="showRoomSettings"
					:false-icon="mdiChevronUp"
					:true-icon="mdiChevronDown"
				/>

				<v-expand-transition>
					<div v-if="showRoomSettings">
						<AutoSkipSegmentSettings v-model="autoSkipCategories" />
					</div>
				</v-expand-transition>

				<v-checkbox
					:label="$t('client-settings.enable-adapter-selector')"
					v-model="settings.enableAdapterSelector"
				/>
			</v-card-text>

			<v-divider />

			<v-card-actions>
				<v-spacer />
				<v-btn color="primary" @click="applySettings">
					{{ $t("common.save") }}
				</v-btn>
				<v-btn @click="cancelSettings">
					{{ $t("common.cancel") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script lang="ts" setup>
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
import _ from "lodash";
import { ALL_SKIP_CATEGORIES } from "ott-common";
import { computed, type Ref, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MediaPlayer, MediaPlayerWithAudioBoost } from "@/components/composables";
import { useMediaPlayer } from "@/components/composables";
import { useSfx } from "@/plugins/sfx";
import { useStore } from "@/store";
import {
	CHAT_OVERLAY_SECONDS_OPTIONS,
	CONTROLS_HIDE_SECONDS_OPTIONS,
	HLS_BUFFER_SECONDS_OPTIONS,
	RoomLayoutMode,
	type SettingsState,
	Theme,
} from "@/stores/settings";
import { enumKeys } from "@/util/misc";
import AutoSkipSegmentSettings from "./AutoSkipSegmentSettings.vue";

type ExcludedFields = "volume" | "locale";
type ExposedSettings = Omit<SettingsState, ExcludedFields>;
const EXCLUDED: ExcludedFields[] = ["volume", "locale"];

const show = ref(false);
const store = useStore();
const controls = useMediaPlayer();
const { t } = useI18n();
const settings: Ref<ExposedSettings> = ref(loadSettings());
const sfx = useSfx();
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

const showRoomSettings = ref(false);
const autoSkipCategories = ref(
	settings.value.defaultRoomSettings?.autoSkipSegmentCategories ?? ALL_SKIP_CATEGORIES,
);

watch(autoSkipCategories, categories => {
	settings.value.defaultRoomSettings = {
		...settings.value.defaultRoomSettings,
		autoSkipSegmentCategories: categories,
	};
});

function loadSettings(): ExposedSettings {
	const copy = _.cloneDeep(store.state.settings);
	const filtered = _.omit(copy, EXCLUDED);
	return filtered;
}

function applySettings() {
	store.commit("settings/UPDATE", settings.value);
	show.value = false;
}

function implementsAudioBoost(player: MediaPlayer | null): player is MediaPlayerWithAudioBoost {
	return !!player && "setAudioBoost" in player;
}

function cancelSettings() {
	show.value = false;
}

watch(show, () => {
	settings.value = loadSettings();
});

watch(
	() => [store.state.settings.sfxEnabled, store.state.settings.sfxVolume] as const,
	([enabled, volume]) => {
		sfx.enabled = enabled;
		sfx.volume.value = volume;
	},
	{ immediate: true },
);

const layouts = enumKeys(RoomLayoutMode);
const themes = enumKeys(Theme);
const isAudioBoostUnsupported = computed(() => {
	if (!controls.checkForPlayer(controls.player.value)) {
		return false;
	}

	return !implementsAudioBoost(controls.player.value);
});
const audioBoostHint = computed(() => {
	if (isAudioBoostUnsupported.value) {
		return t("client-settings.audio-boost-unsupported");
	}

	return t("client-settings.audio-boost-hint");
});
</script>

<style scoped>
.audio-boost-value {
	min-width: 3.5rem;
	text-align: right;
}
</style>
