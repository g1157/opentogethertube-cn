<template>
	<div class="hero-shader" :class="{ 'is-active': active, 'is-light': light }" aria-hidden="true">
		<div class="plasma-field">
			<div class="plasma-layer plasma-core"></div>
			<div class="plasma-layer plasma-accent"></div>
		</div>
		<div class="plasma-vignette"></div>
	</div>
</template>

<script lang="ts" setup>
withDefaults(defineProps<{ active?: boolean; light?: boolean }>(), {
	active: false,
	light: false,
});
</script>

<style scoped>
/* Lightweight adaptation of upstream's amber plasma / light silk backdrop.
   Theme colors and the calm reading zone are retained without a WebGPU runtime. */
.hero-shader {
	position: absolute;
	inset: 0;
	z-index: 0;
	overflow: hidden;
	contain: paint;
	pointer-events: none;
	background: var(--hero-base, var(--ink));
}

.plasma-field {
	position: absolute;
	inset: 0;
	mask-image: linear-gradient(to right, transparent 8%, rgb(0 0 0 / 0.25) 36%, black 78%);
}

.plasma-layer {
	position: absolute;
	inset: -25% -20% -30% 15%;
	border-radius: 44%;
	animation: plasma-drift 32s ease-in-out infinite alternate;
	animation-play-state: paused;
}

.plasma-core {
	background: radial-gradient(
			ellipse 30% 56% at 72% 32%,
			color-mix(in srgb, var(--hero-core-a, var(--primary)) 55%, transparent),
			transparent 72%
		),
		radial-gradient(
			ellipse 54% 32% at 58% 78%,
			color-mix(in srgb, var(--primary) 34%, transparent),
			transparent 75%
		),
		conic-gradient(
			from 145deg at 68% 48%,
			transparent 0deg,
			color-mix(in srgb, var(--primary) 25%, transparent) 60deg,
			transparent 115deg,
			color-mix(in srgb, var(--primary) 20%, transparent) 165deg,
			transparent 245deg
		);
	filter: blur(22px);
	opacity: 0.9;
}

.plasma-accent {
	background: radial-gradient(
			ellipse 36% 12% at 68% 38%,
			color-mix(in srgb, var(--signal) 28%, transparent),
			transparent 75%
		),
		radial-gradient(
			ellipse 16% 38% at 81% 62%,
			color-mix(in srgb, var(--signal) 24%, transparent),
			transparent 74%
		);
	filter: blur(15px);
	mix-blend-mode: screen;
	animation-name: accent-drift;
	animation-duration: 38s;
}

.plasma-vignette {
	position: absolute;
	inset: 0;
	background: radial-gradient(
			ellipse 80% 100% at 65% 45%,
			transparent 30%,
			color-mix(in srgb, var(--ink) 60%, transparent) 100%
		),
		linear-gradient(to top, color-mix(in srgb, var(--ink) 65%, transparent), transparent 35%);
}

.is-active .plasma-layer {
	animation-play-state: running;
	will-change: transform;
}

.is-light {
	background: var(--background);
}

.is-light .plasma-field {
	mask-image: linear-gradient(to right, transparent 10%, rgb(0 0 0 / 0.12) 38%, black 85%);
}

.is-light .plasma-core {
	opacity: 0.7;
}

.is-light .plasma-accent {
	mix-blend-mode: multiply;
	opacity: 0.7;
}

@keyframes plasma-drift {
	from {
		transform: translate3d(-3%, -3%, 0) rotate(-12deg) scale(1);
	}
	to {
		transform: translate3d(4%, 5%, 0) rotate(8deg) scale(1.08);
	}
}

@keyframes accent-drift {
	from {
		transform: translate3d(4%, 4%, 0) rotate(16deg);
	}
	to {
		transform: translate3d(-5%, -3%, 0) rotate(-9deg);
	}
}

@media (max-width: 599px) {
	.plasma-field {
		opacity: 0.7;
	}

	.plasma-layer {
		inset: -10% -20% -10% 0;
	}
}

@media (prefers-reduced-motion: reduce) {
	.plasma-layer {
		animation: none;
	}

	.is-active .plasma-layer {
		will-change: auto;
	}
}
</style>
