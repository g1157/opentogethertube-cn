<template>
	<div v-if="visible" class="media-loading-notice" data-cy="media-loading-notice">
		<div class="media-loading-card">
			<strong role="status" aria-live="polite">
				{{ $t(`player.loading.${titleKey}`) }}
			</strong>
			<v-progress-linear
				v-if="!preparationFailed"
				indeterminate
				color="primary"
				height="3"
				rounded
				:aria-label="$t('common.loading')"
			/>
			<p class="loading-timing" aria-live="off">
				{{ $t("player.loading.elapsed", { seconds: elapsedSeconds }) }}
				<span v-if="bufferedSeconds !== null">
					· {{ $t("player.loading.buffer-ahead", { seconds: bufferedSeconds }) }}
				</span>
			</p>
			<p>
				{{ $t(`player.loading.${hintKey}`) }}
			</p>
			<template v-if="takingLonger">
				<p role="status" class="loading-slow">
					{{
						$t(
							preparationFailed
								? "player.loading.resume-failed"
								: "player.loading.slow",
						)
					}}
				</p>
				<v-btn
					v-if="canRetry"
					size="small"
					color="primary"
					data-cy="retry-loading-media"
					@pointerdown.stop
					@pointerup.stop
					@click.stop="emit('retry')"
				>
					{{ $t("player.retry-local") }}
				</v-btn>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MediaLoadingState } from "@/util/media-loading-state";

const props = defineProps<{
	state: MediaLoadingState;
	roomPlaying: boolean;
	canRetry: boolean;
	preparationFailed?: boolean;
	resuming?: boolean;
	waitingForViewer?: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
const elapsedMs = ref(0);
const startedAt = performance.now();
let timer: ReturnType<typeof setInterval> | undefined;

// Do not flash the notice for a brief seek into data that is already available.
const visible = computed(() => elapsedMs.value >= 300);
const elapsedSeconds = computed(() => Math.ceil(elapsedMs.value / 1000));
const takingLonger = computed(() => props.preparationFailed || elapsedMs.value >= 15000);
const titleKey = computed(() =>
	props.preparationFailed
		? "resume-retry"
		: props.waitingForViewer && props.state.currentTime !== null
		? "waiting-viewer"
		: props.state.phase ?? "preparing",
);
const hintKey = computed(() =>
	props.waitingForViewer
		? "wait-together"
		: props.resuming
		? "resume-saved"
		: props.roomPlaying
		? "join-playing"
		: "join-paused",
);
const bufferedSeconds = computed(() => {
	const ahead = props.state.bufferAhead;
	return ahead !== null && Number.isFinite(ahead) && ahead >= 0
		? Math.floor(ahead * 10) / 10
		: null;
});

onMounted(() => {
	timer = setInterval(() => {
		elapsedMs.value = Math.max(0, performance.now() - startedAt);
	}, 250);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped lang="scss">
.media-loading-notice {
	position: absolute;
	inset: 0;
	z-index: 4;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 16px 16px max(16px, var(--player-controls-height, 0px));
	pointer-events: none;
}

.media-loading-card {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
	width: min(360px, 100%);
	padding: 18px;
	border: 1px solid var(--line-strong);
	border-radius: 12px;
	background: color-mix(in srgb, var(--ink) 92%, transparent);
	color: var(--foreground);
	text-align: center;
	font-size: 0.875rem;

	strong {
		font-size: 1rem;
	}

	p {
		margin: 0;
		line-height: 1.5;
	}

	.loading-timing {
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
	}

	.loading-slow {
		color: var(--warning);
	}

	.v-btn {
		pointer-events: auto;
	}
}

@media (max-height: 480px) {
	.media-loading-card {
		gap: 6px;
		padding: 12px;
	}
}
</style>
