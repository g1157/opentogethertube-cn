<template>
	<v-container class="help-page">
		<h1>{{ $t("help.title") }}</h1>
		<p class="intro">{{ $t("help.intro") }}</p>

		<h2>{{ $t("help.add.title") }}</h2>
		<p>{{ $t("help.add.text") }}</p>
		<ul>
			<li v-for="key in addItems" :key="key">{{ $t(`help.add.items.${key}`) }}</li>
		</ul>
		<p class="note">{{ $t("help.add.note") }}</p>

		<h2>{{ $t("help.playback.title") }}</h2>
		<p>{{ $t("help.playback.text") }}</p>

		<h2>{{ $t("help.buffering.title") }}</h2>
		<ul>
			<li v-for="key in bufferingItems" :key="key">
				{{ $t(`help.buffering.items.${key}`) }}
			</li>
		</ul>

		<h2>{{ $t("help.enhance.title") }}</h2>
		<p>{{ $t("help.enhance.text") }}</p>

		<h2>{{ $t("help.shortcuts.title") }}</h2>
		<p>{{ $t("help.shortcuts.text") }}</p>

		<h2>{{ $t("help.rooms.title") }}</h2>
		<p>{{ $t("help.rooms.text") }}</p>

		<h2>{{ $t("help.contact.title") }}</h2>
		<p>{{ $t("help.contact.text") }}</p>
		<ul>
			<li>
				<a
					href="https://github.com/dyc3/opentogethertube/discussions/830"
					target="_blank"
					rel="noopener noreferrer"
				>
					{{ $t("help.contact.upstream") }}
				</a>
			</li>
			<li>
				<a
					href="https://github.com/g1157/opentogethertube-cn/issues"
					target="_blank"
					rel="noopener noreferrer"
				>
					{{ $t("help.contact.bug") }}
				</a>
			</li>
		</ul>
	</v-container>
</template>

<script setup lang="ts">
const addItems = ["youtube", "vimeo", "direct", "hls", "dash", "manifest", "bilibili"] as const;
const bufferingItems = ["cors", "unreachable", "retry", "gate", "source"] as const;
</script>

<style lang="scss" scoped>
.help-page {
	max-width: 900px;

	h1 {
		margin-bottom: 12px;
	}

	h2 {
		margin-top: 28px;
		margin-bottom: 8px;
	}

	p {
		margin: 8px 0;
		line-height: 1.7;
	}

	ul {
		margin: 8px 0;
		padding-left: 20px;
	}

	li {
		margin: 6px 0;
		line-height: 1.6;
	}

	.intro,
	.note {
		color: var(--muted-foreground);
	}
}
</style>
