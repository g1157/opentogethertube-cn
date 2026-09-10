<template>
	<v-btn v-if="isEdgePreview" class="nav-user" variant="text" to="/my-rooms">
		{{ $t("edge-preview.guest") }}
	</v-btn>
	<v-menu
		v-else-if="store.state.user"
		v-model="menuOpen"
		location="bottom end"
		:offset="8"
		:max-width="320"
		:max-height="360"
		scroll-strategy="reposition"
	>
		<template v-slot:activator="{ props }">
			<v-btn
				class="nav-user"
				variant="text"
				v-bind="props"
				:key="store.state.user.username"
				data-cy="user-logged-in"
			>
				{{ store.state.user.username }}
			</v-btn>
		</template>
		<v-list two-line max-width="400">
			<v-list-item to="/account">
				<v-list-item-title>{{ $t("nav.account") }}</v-list-item-title>
			</v-list-item>
			<v-list-item @click="goLoginDiscord" v-if="!store.state.user.discordLinked">
				<v-list-item-title>{{ $t("nav.link-discord") }}</v-list-item-title>
			</v-list-item>
			<v-list-item @click="$emit('logout')">
				<v-list-item-title>{{ $t("nav.logout") }}</v-list-item-title>
			</v-list-item>
		</v-list>
	</v-menu>
	<v-btn class="nav-user" variant="text" @click="$emit('login')" data-cy="user-logged-out" v-else>
		{{ $t("nav.login") }}
	</v-btn>
</template>

<script lang="ts" setup>
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import { goLoginDiscord } from "@/util/discord";
import { useStore } from "@/store";
import { isEdgePreview } from "@/edge-preview";

defineEmits(["login", "logout"]);
const store = useStore();
const route = useRoute();
const menuOpen = ref(false);
watch(
	[() => store.state.fullscreen, () => store.state.user?.username, () => route.fullPath],
	() => {
		menuOpen.value = false;
	},
);
</script>

<style scoped>
.nav-user {
	max-width: 160px;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped styles support :deep. */
.nav-user :deep(.v-btn__content) {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
@media (max-width: 959px) {
	.nav-user {
		max-width: 80px;
	}
}
</style>
