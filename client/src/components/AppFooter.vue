<template>
	<footer class="app-footer" :lang="$i18n.locale">
		<p class="footer-upstream">
			{{ $t("footer.upstream") }}:
			<a href="https://github.com/dyc3/opentogethertube">OpenTogetherTube</a>
		</p>
	</footer>
</template>

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
