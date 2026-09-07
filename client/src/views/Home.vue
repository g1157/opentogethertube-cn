<template>
	<div class="home" :lang="$i18n.locale">
		<section ref="hero" class="hero" :class="{ 'motion-active': effectsActive }">
			<HeroShader :active="effectsActive" :light="isLightTheme" />
			<div class="hero-content">
				<p class="hero-eyebrow">
					<span class="hero-status" aria-hidden="true"></span>
					{{ $t("landing.hero.eyebrow") }}
				</p>
				<h1 class="hero-title">
					{{ $t("landing.hero.title") }}
					<span class="hero-scanlines" aria-hidden="true">{{
						$t("landing.hero.title")
					}}</span>
				</h1>
				<p class="hero-description">{{ $t("landing.hero.description") }}</p>
				<div class="hero-buttons">
					<v-btn
						class="home-button home-button-primary"
						size="x-large"
						variant="flat"
						:loading="store.state.misc.isLoadingCreateRoom"
						:prepend-icon="mdiPlay"
						@click="createTempRoom"
					>
						{{ $t("landing.hero.btns.create") }}
					</v-btn>
					<v-btn
						class="home-button home-button-outline"
						size="x-large"
						variant="outlined"
						to="/rooms"
					>
						{{ $t("landing.hero.btns.browse") }}
					</v-btn>
					<v-btn
						class="home-button home-button-outline"
						size="x-large"
						variant="outlined"
						:href="sourceUrl"
						target="_blank"
						rel="noopener noreferrer"
						:prepend-icon="mdiGithub"
					>
						{{ $t("landing.hero.btns.source") }}
					</v-btn>
				</div>
			</div>
			<div class="hero-filmstrip" aria-hidden="true"></div>
		</section>

		<div class="home-content">
			<section class="intro-section">
				<h2 class="section-title">{{ $t("landing.intro.title") }}</h2>
				<div class="intro-copy">
					<p>
						<strong>{{ $t("landing.intro.name") }}</strong>
						{{ $t("landing.intro.text1") }}
					</p>
					<p>{{ $t("landing.intro.text2") }}</p>
					<p>
						{{ $t("landing.intro.text3") }}
						<a
							href="https://github.com/dyc3/opentogethertube/labels/service%20support%20request"
							>{{ $t("landing.intro.link") }}</a
						>
					</p>
				</div>
			</section>

			<section class="features-section">
				<h2 class="section-title">{{ $t("landing.features.title") }}</h2>
				<div class="feature-grid">
					<article
						v-for="(feature, index) in features"
						:key="feature.key"
						class="feature-card"
					>
						<v-icon
							:icon="feature.icon"
							class="feature-icon"
							size="28"
							aria-hidden="true"
						/>
						<h3>{{ $t("landing.features." + feature.key + ".title") }}</h3>
						<p>{{ $t("landing.features." + feature.key + ".text") }}</p>
						<span class="feature-index" aria-hidden="true">{{
							String(index + 1).padStart(2, "0")
						}}</span>
					</article>
				</div>
			</section>

			<section class="support-section">
				<div>
					<h2 class="section-title">{{ $t("landing.support.title") }}</h2>
					<p class="support-copy">
						<strong>{{ $t("landing.support.description1") }}</strong>
						{{ $t("landing.support.description2") }}
					</p>
				</div>
				<div class="support-actions">
					<h3>{{ $t("landing.support.how") }}</h3>
					<v-btn
						class="home-button home-button-primary"
						size="large"
						variant="flat"
						block
						href="https://github.com/sponsors/dyc3"
						target="_blank"
						rel="noopener noreferrer"
						:prepend-icon="mdiHeart"
					>
						{{ $t("landing.support.sponsor") }}
					</v-btn>
					<v-btn
						class="home-button home-button-signal"
						size="large"
						variant="outlined"
						block
						href="https://github.com/g1157/opentogethertube-cn"
						target="_blank"
						rel="noopener noreferrer"
						:prepend-icon="mdiXml"
					>
						{{ $t("landing.support.contribute") }}
					</v-btn>
				</div>
			</section>

			<p class="home-disclaimer">{{ $t("footer.disclaimer") }}</p>
			<AppFooter />
		</div>
	</div>
</template>

<script lang="ts" setup>
import {
	mdiContentCopy,
	mdiGithub,
	mdiHeart,
	mdiPin,
	mdiPlay,
	mdiShieldLock,
	mdiSync,
	mdiVote,
	mdiWeatherNight,
	mdiXml,
} from "@mdi/js";
import {
	useDocumentVisibility,
	useIntersectionObserver,
	usePreferredReducedMotion,
} from "@vueuse/core";
import { computed, ref } from "vue";
import AppFooter from "@/components/AppFooter.vue";
import HeroShader from "@/components/HeroShader.vue";
import { useStore } from "@/store";
import { createRoomHelper } from "@/util/roomcreator";

const store = useStore();
const sourceUrl = import.meta.env.VITE_SOURCE_URL || "https://github.com/g1157/opentogethertube-cn";
const hero = ref<HTMLElement | null>(null);
const heroVisible = ref(false);
const documentVisibility = useDocumentVisibility();
const preferredMotion = usePreferredReducedMotion();
const effectsActive = computed(
	() =>
		heroVisible.value &&
		documentVisibility.value === "visible" &&
		preferredMotion.value !== "reduce",
);
const isLightTheme = computed(() => ["light", "strawberry"].includes(store.state.settings.theme));

// VueUse releases the observer and visibility/media listeners when this view unmounts.
useIntersectionObserver(hero, ([entry]) => {
	heroVisible.value = Boolean(entry?.isIntersecting);
});

const features = [
	{ key: "synchronized-playback", icon: mdiSync },
	{ key: "permanent-rooms", icon: mdiPin },
	{ key: "dark-theme", icon: mdiWeatherNight },
	{ key: "room-permissions", icon: mdiShieldLock },
	{ key: "voting-system", icon: mdiVote },
	{ key: "playlist-copying", icon: mdiContentCopy },
];

async function createTempRoom() {
	if (store.state.misc.isLoadingCreateRoom) {
		return;
	}
	try {
		await createRoomHelper(store);
	} catch {
		// The shared helper already displays the failure and clears the loading state.
	}
}
</script>

<style scoped>
/* Adapted from upstream's visual overhaul, retaining the existing Vuetify controls. */
.home {
	width: 100%;
	background: var(--background);
	color: var(--foreground);
	font-family: var(--font-body);
}

.hero {
	position: relative;
	isolation: isolate;
	overflow: hidden;
	background: radial-gradient(
			60% 50% at 50% 0%,
			color-mix(in srgb, var(--primary) 10%, transparent),
			transparent 70%
		),
		var(--ink);
	border-bottom: 1px solid var(--line-strong);
}

.hero-content {
	position: relative;
	z-index: 1;
	display: flex;
	flex-direction: column;
	justify-content: center;
	max-width: 1024px;
	min-height: 88vh;
	min-height: 88svh;
	margin: 0 auto;
	padding: clamp(4rem, 10vh, 7rem) 1.5rem;
}

.hero-eyebrow {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	margin-bottom: 1.5rem;
	color: var(--primary);
	font-family: var(--font-mono);
	font-size: 0.75rem;
	line-height: 1.7;
	letter-spacing: 0.2em;
	text-transform: uppercase;
}

.hero-status {
	flex: 0 0 8px;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--primary);
	box-shadow: 0 0 10px var(--primary);
	animation: marquee-pulse 4s ease-in-out infinite;
	animation-play-state: paused;
}

.hero-title {
	position: relative;
	align-self: flex-start;
	max-width: 100%;
	margin: 0;
	color: var(--primary);
	font-family: var(--font-display);
	font-size: clamp(3.5rem, 11vw, 8rem);
	font-weight: 400;
	line-height: 0.98;
	letter-spacing: 0.01em;
	text-transform: uppercase;
	text-wrap: balance;
	overflow-wrap: anywhere;
	text-shadow: var(--hero-text-glow);
}

.hero-title:lang(zh) {
	font-size: clamp(2.4rem, 7vw, 6.5rem);
	font-weight: 800;
	line-height: 1.2;
	letter-spacing: 0.025em;
}

.hero-scanlines {
	position: absolute;
	inset: 0;
	pointer-events: none;
	background: repeating-linear-gradient(
		to bottom,
		transparent 0,
		transparent 2px,
		rgb(0 0 0 / 0.45) 3px,
		transparent 4px
	);
	background-clip: text;
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
	color: transparent;
	text-shadow: none;
}

.hero-description {
	max-width: 640px;
	margin-top: 1.5rem;
	color: var(--muted-foreground);
	font-size: clamp(1rem, 1.8vw, 1.25rem);
	line-height: 1.8;
	white-space: pre-line;
}

.hero-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 1rem;
	margin-top: 2.5rem;
}

.home-button.v-btn {
	min-height: 48px;
	border-radius: var(--radius-md, 8px);
	font-family: var(--font-body);
	font-weight: 700;
	letter-spacing: 0.06em;
	text-transform: none;
	transition: box-shadow 0.2s ease, border-color 0.2s ease;
}

.home-button-primary.v-btn {
	background: var(--primary);
	color: var(--primary-foreground);
	box-shadow: var(--glow-primary);
}

.home-button-outline.v-btn {
	border-color: color-mix(in srgb, var(--primary) 55%, transparent);
	background: color-mix(in srgb, var(--ink) 80%, transparent);
	color: var(--primary);
}

.home-button-signal.v-btn {
	border-color: color-mix(in srgb, var(--signal) 55%, transparent);
	background: color-mix(in srgb, var(--signal) 8%, var(--card));
	color: var(--signal);
}

.home-button:focus-visible {
	outline: 2px solid var(--signal);
	outline-offset: 4px;
}

.hero-filmstrip {
	position: absolute;
	z-index: 1;
	bottom: 0;
	left: 0;
	right: 0;
	height: 18px;
	background: repeating-linear-gradient(to right, var(--primary) 0 14px, transparent 14px 34px);
	opacity: 0.5;
	mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent);
}

.home-content {
	max-width: 1152px;
	margin: 0 auto;
	padding: 5rem 1.5rem 2.5rem;
}

.intro-section {
	max-width: 800px;
	margin-bottom: 6rem;
}

.section-title {
	position: relative;
	margin: 0;
	padding-left: 1rem;
	font-family: var(--font-display);
	font-size: clamp(2rem, 5vw, 3rem);
	font-weight: 400;
	line-height: 1.15;
	letter-spacing: 0.02em;
	text-transform: uppercase;
	overflow-wrap: anywhere;
}

.section-title:lang(zh) {
	font-family: var(--font-body);
	font-size: clamp(1.5rem, 3.5vw, 2.25rem);
	font-weight: 700;
	line-height: 1.45;
}

.section-title::before {
	content: "";
	position: absolute;
	left: 0;
	top: 0.1em;
	bottom: 0.1em;
	width: 4px;
	background: var(--primary);
	box-shadow: 0 0 12px var(--primary);
}

.intro-copy {
	display: grid;
	gap: 1rem;
	margin-top: 1.5rem;
}

.intro-copy,
.support-copy {
	color: var(--muted-foreground);
	line-height: 1.85;
}

.home strong {
	color: var(--foreground);
}

.intro-copy a {
	color: var(--signal);
	text-decoration: underline;
	text-underline-offset: 3px;
}

.intro-copy a:hover {
	color: var(--primary);
}

.features-section {
	margin-bottom: 6rem;
}

.feature-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 1rem;
	margin-top: 2.5rem;
}

.feature-card {
	position: relative;
	min-width: 0;
	overflow: hidden;
	border: 1px solid var(--line);
	border-radius: var(--radius-lg, 10px);
	background: linear-gradient(160deg, var(--card), var(--background));
	padding: 1.75rem;
	box-shadow: var(--shadow-panel);
	transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

.feature-icon {
	color: var(--primary);
}

.feature-card h3 {
	margin-top: 1rem;
	font-family: var(--font-display);
	font-size: 1.65rem;
	font-weight: 400;
	line-height: 1.2;
	letter-spacing: 0.025em;
	text-transform: uppercase;
}

.feature-card h3:lang(zh) {
	font-family: var(--font-body);
	font-size: 1.25rem;
	font-weight: 700;
	line-height: 1.5;
}

.feature-card p {
	margin-top: 0.6rem;
	color: var(--muted-foreground);
	font-size: 0.9375rem;
	line-height: 1.8;
	overflow-wrap: anywhere;
}

.feature-index {
	position: absolute;
	top: 1rem;
	right: 1.1rem;
	color: var(--text-dim, var(--muted-foreground));
	font-family: var(--font-mono);
	font-size: 0.75rem;
	letter-spacing: 0.15em;
}

.support-section {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	align-items: center;
	gap: 2.5rem;
	margin-bottom: 5rem;
}

.support-copy {
	margin-top: 1.5rem;
}

.support-actions {
	display: grid;
	gap: 0.75rem;
}

.support-actions h3 {
	color: var(--muted-foreground);
	font-size: 1.125rem;
	font-weight: 500;
	line-height: 1.5;
}

.home-disclaimer {
	margin-bottom: 2.5rem;
	color: var(--text-dim, var(--muted-foreground));
	font-size: 0.8125rem;
	font-style: italic;
	line-height: 1.7;
}

.motion-active .hero-status {
	animation-play-state: running;
}

@keyframes marquee-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.55;
	}
}

@media (hover: hover) {
	.feature-card:hover {
		border-color: color-mix(in srgb, var(--primary) 55%, transparent);
		transform: translateY(-4px);
		box-shadow: var(--shadow-panel), var(--glow-primary);
	}

	.home-button-outline:hover {
		box-shadow: var(--glow-primary);
	}

	.home-button-signal:hover {
		box-shadow: var(--glow-signal);
	}
}

@media (max-width: 959px) {
	.feature-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.support-section {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (max-width: 599px) {
	.hero-content {
		min-height: calc(100svh - 64px);
		padding: 4.5rem 1.25rem 4rem;
	}

	.hero-eyebrow {
		font-size: 0.6875rem;
		letter-spacing: 0.12em;
	}

	.hero-buttons {
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 2rem;
	}

	.home-content {
		padding: 3.5rem 1.25rem 2rem;
	}

	.intro-section,
	.features-section {
		margin-bottom: 3.5rem;
	}

	.feature-grid {
		grid-template-columns: minmax(0, 1fr);
		margin-top: 1.75rem;
	}

	.feature-card {
		padding: 1.5rem;
	}

	.support-section {
		margin-bottom: 3rem;
	}
}

@media (prefers-reduced-motion: reduce) {
	.hero-status {
		animation: none;
	}

	.feature-card,
	.home-button.v-btn {
		transition: none;
	}

	.feature-card:hover {
		transform: none;
	}
}
</style>
