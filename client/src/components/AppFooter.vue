<template>
	<footer class="app-footer" :lang="$i18n.locale">
		<p class="footer-upstream">
			{{ $t("footer.upstream") }}:
			<a href="https://github.com/dyc3/opentogethertube">OpenTogetherTube</a>
		</p>
		<p class="footer-credit">
			{{ new Date().getFullYear() }} —
			<a href="https://carsonmcmanus.com/">Carson McManus</a> — {{ $t("footer.made-in") }} —
			{{ $t("footer.thanks-to") }} <a href="https://softe.club">SEC</a> @ Stevens
		</p>
		<nav class="footer-links">
			<router-link v-if="isOfficialSite()" to="/privacypolicy">{{
				$t("footer.privacy-policy")
			}}</router-link>
			<router-link to="/attribution">{{ $t("footer.attribution") }}</router-link>
			<a :href="sourceUrl" target="_blank" rel="noopener noreferrer">{{
				$t("landing.hero.btns.source")
			}}</a>
			<a href="/source-code.tar.gz" download>{{ $t("footer.download-source") }}</a>
		</nav>
	</footer>
</template>

<script lang="ts" setup>
import { isOfficialSite } from "@/util/misc";

const sourceUrl = import.meta.env.VITE_SOURCE_URL || "https://github.com/g1157/opentogethertube-cn";
</script>

<style scoped>
.app-footer {
	border-top: 1px solid var(--line);
	padding-top: 2rem;
	color: var(--muted-foreground);
	font-family: var(--font-body);
	font-size: 0.75rem;
	line-height: 1.9;
	text-align: center;
}

.footer-upstream {
	margin: 0 0 0.5rem;
	font-family: var(--font-mono);
	letter-spacing: 0.04em;
}

.footer-credit {
	margin: 0;
}

.footer-links {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 0.5rem 1.5rem;
	margin-top: 0.75rem;
}

.app-footer a {
	color: var(--signal);
	text-decoration: none;
	text-underline-offset: 3px;
	transition: color 0.15s ease;
}

.app-footer a:hover,
.app-footer a:focus-visible {
	color: var(--primary);
	text-decoration: underline;
}

.app-footer a:focus-visible {
	outline: 2px solid var(--signal);
	outline-offset: 4px;
}

@media (prefers-reduced-motion: reduce) {
	.app-footer a {
		transition: none;
	}
}
</style>
