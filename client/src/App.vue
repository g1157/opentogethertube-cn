<template>
	<v-app id="app" class="ott-app">
		<a class="skip-link" href="#main-content">{{ $t("common.skip-content") }}</a>
		<v-app-bar
			v-show="!fullscreen"
			class="ott-app-bar"
			:height="$vuetify.display.mdAndUp ? 64 : 60"
			:elevation="0"
		>
			<div class="nav-shell">
				<v-btn
					v-if="!$vuetify.display.lgAndUp"
					icon
					variant="text"
					:aria-label="$t('common.nav-menu')"
					@click="drawer = true"
				>
					<v-icon :icon="mdiMenu" />
				</v-btn>
				<router-link
					class="nav-brand"
					to="/"
					:aria-label="`OpenTogetherTube · ${$t('nav.home')}`"
				>
					<img :src="logoUrl" width="30" height="30" alt="" />
					<span class="ott-text-scanlines" data-text="OpenTogetherTube"
						>OpenTogetherTube</span
					>
				</router-link>
				<nav
					v-if="$vuetify.display.lgAndUp"
					class="nav-links"
					:aria-label="$t('common.nav-menu')"
				>
					<v-btn variant="text" to="/rooms">{{ $t("nav.browse") }}</v-btn>
					<v-btn v-if="store.state.user" variant="text" to="/my-rooms">{{
						$t("nav.my-rooms")
					}}</v-btn>
					<v-btn
						variant="text"
						href="https://github.com/dyc3/opentogethertube/discussions/830"
						target="_blank"
						rel="noopener noreferrer"
						>{{ $t("nav.faq") }}</v-btn
					>
				</nav>
				<div class="nav-actions">
					<v-menu
						v-if="$vuetify.display.mdAndUp"
						v-model="showCreateMenu"
						location="bottom end"
						:offset="8"
						:max-width="320"
						:max-height="360"
						scroll-strategy="reposition"
					>
						<template #activator="{ props }">
							<v-btn
								class="nav-create"
								variant="outlined"
								color="primary"
								:prepend-icon="mdiPlusBox"
								v-bind="props"
								>{{ $t("nav.create.title") }}</v-btn
							>
						</template>
						<v-list width="320" max-width="90vw">
							<NavCreateRoom
								@createtemp="createTempRoom"
								@createperm="createPermanentRoom"
							/>
						</v-list>
					</v-menu>
					<NavUser @login="openLogin" @logout="logout" />
					<LocaleSelector v-if="$vuetify.display.mdAndUp" />
					<v-menu
						v-if="$vuetify.display.lgAndUp"
						v-model="showMoreMenu"
						location="bottom end"
						:offset="8"
						:max-width="320"
						:max-height="360"
						scroll-strategy="reposition"
					>
						<template #activator="{ props }">
							<v-btn
								icon
								variant="text"
								:aria-label="$t('common.more')"
								v-bind="props"
								><v-icon :icon="mdiDotsHorizontal"
							/></v-btn>
						</template>
						<v-list>
							<v-list-item
								href="https://github.com/g1157/opentogethertube-cn"
								target="_blank"
								rel="noopener noreferrer"
								:prepend-icon="mdiGithub"
								:title="$t('landing.hero.btns.source')"
							/>
							<v-list-item
								href="https://github.com/g1157/opentogethertube-cn/issues"
								target="_blank"
								rel="noopener noreferrer"
								:prepend-icon="mdiBug"
								:title="$t('nav.bug')"
							/>
							<v-list-item
								href="https://github.com/sponsors/dyc3"
								target="_blank"
								rel="noopener noreferrer"
								:prepend-icon="mdiHeart"
								:title="$t('nav.support')"
							/>
						</v-list>
					</v-menu>
				</div>
			</div>
		</v-app-bar>
		<v-navigation-drawer v-model="drawer" class="nav-drawer" temporary :width="300">
			<div class="drawer-heading">
				<span class="label-mono">{{ $t("common.nav-menu") }}</span
				><v-btn icon variant="text" :aria-label="$t('common.close')" @click="drawer = false"
					><v-icon :icon="mdiClose"
				/></v-btn>
			</div>
			<v-list nav>
				<v-list-item to="/" @click="drawer = false">{{ $t("nav.home") }}</v-list-item>
				<v-list-item to="/rooms" @click="drawer = false">{{
					$t("nav.browse")
				}}</v-list-item>
				<v-list-item v-if="store.state.user" to="/my-rooms" @click="drawer = false">{{
					$t("nav.my-rooms")
				}}</v-list-item>
				<v-list-item
					href="https://github.com/dyc3/opentogethertube/discussions/830"
					target="_blank"
					rel="noopener noreferrer"
					>{{ $t("nav.faq") }}</v-list-item
				>
				<v-list-item
					href="https://github.com/g1157/opentogethertube-cn/issues"
					target="_blank"
					rel="noopener noreferrer"
					:prepend-icon="mdiBug"
					>{{ $t("nav.bug") }}</v-list-item
				>
				<v-divider class="drawer-divider" />
				<NavCreateRoom @createtemp="createTempRoom" @createperm="createPermanentRoom" />
			</v-list>
			<template #append>
				<div v-if="drawer" class="drawer-account">
					<NavUser @login="openLogin" @logout="logout" /><LocaleSelector />
				</div>
			</template>
		</v-navigation-drawer>
		<v-main id="main-content" tabindex="-1"><router-view /></v-main>
		<v-dialog
			v-model="showCreateRoomForm"
			persistent
			max-width="600"
			:aria-label="$t('create-room-form.card-title')"
		>
			<CreateRoomForm
				@roomCreated="showCreateRoomForm = false"
				@cancel="showCreateRoomForm = false"
			/>
		</v-dialog>
		<v-dialog v-model="showLogin" max-width="600" :aria-label="$t('nav.login')"
			><LogInForm @shouldClose="showLogin = false"
		/></v-dialog>
		<v-overlay
			class="overlay-loading-create-room"
			:model-value="store.state.misc.isLoadingCreateRoom"
		>
			<div class="room-creation-progress" role="status">
				<v-progress-circular color="primary" indeterminate :size="48" />
				<span>{{ $t("quick-room.text") }}</span>
				<v-btn variant="outlined" @click="cancelRoom">{{ $t("common.cancel") }}</v-btn>
			</div>
		</v-overlay>
		<Notifier />
	</v-app>
</template>

<script lang="ts">
import {
	mdiBug,
	mdiHeart,
	mdiPlusBox,
	mdiMenu,
	mdiClose,
	mdiDotsHorizontal,
	mdiGithub,
} from "@mdi/js";
import { defineComponent, onMounted, onUnmounted, ref, computed, watch } from "vue";
import { API } from "@/common-http";
import CreateRoomForm from "@/components/CreateRoomForm.vue";
import LogInForm from "@/components/LogInForm.vue";
import NavUser from "@/components/navbar/NavUser.vue";
import NavCreateRoom from "@/components/navbar/NavCreateRoom.vue";
import Notifier from "@/components/Notifier.vue";
import { loadLanguageAsync } from "@/i18n";
import { createRoomHelper } from "@/util/roomcreator";
import { useRouter } from "vue-router";
import { useDisplay } from "vuetify";
import logoUrl from "@/assets/logo.svg";
import { useStore } from "@/store";
import LocaleSelector from "@/components/navbar/LocaleSelector.vue";
import { ALL_THEMES, Theme } from "@/stores/settings";
import "@/styles/cinema-fonts.css";

// biome-ignore lint/nursery/noVueOptionsApi: TODO: convert to setup
const App = defineComponent({
	name: "app",
	components: {
		CreateRoomForm,
		LogInForm,
		NavUser,
		NavCreateRoom,
		Notifier,
		LocaleSelector,
	},
	setup() {
		const store = useStore();
		const router = useRouter();
		const { lgAndUp } = useDisplay();
		let unsubscribe: (() => void) | undefined;
		onUnmounted(() => unsubscribe?.());
		watch(
			() => store.state.settings.theme,
			theme => {
				document.documentElement.dataset.theme = ALL_THEMES.includes(theme)
					? theme
					: Theme.dark;
			},
			{ immediate: true },
		);

		const showCreateRoomForm = ref(false);
		const showLogin = ref(false);
		const drawer = ref(false);
		const showCreateMenu = ref(false);
		const showMoreMenu = ref(false);
		watch([() => store.state.fullscreen, () => router.currentRoute.value.fullPath], () => {
			drawer.value = false;
			showCreateMenu.value = false;
			showMoreMenu.value = false;
		});
		watch(lgAndUp, wideScreen => {
			if (wideScreen) {
				drawer.value = false;
			}
		});

		const logout = async () => {
			const res = await API.post("/user/logout");
			if (res.data.success) {
				store.commit("LOGOUT");
			}
		};

		const setLocale = async (locale: string) => {
			await loadLanguageAsync(locale);
			store.commit("settings/UPDATE", { locale });
		};

		const cancelRoom = () => {
			store.commit("misc/CANCELLED_ROOM_CREATION");
		};

		const createTempRoom = async () => {
			drawer.value = false;
			await createRoomHelper(store);
		};
		const createPermanentRoom = () => {
			drawer.value = false;
			showCreateRoomForm.value = true;
		};
		const openLogin = () => {
			drawer.value = false;
			showLogin.value = true;
		};

		onMounted(async () => {
			unsubscribe = store.subscribe(mutation => {
				if (mutation.type === "misc/ROOM_CREATED") {
					try {
						router.push(`/room/${mutation.payload.name}`);
					} catch (e) {
						if (e.name !== "NavigationDuplicated") {
							throw e;
						}
					}
				}
			});

			await store.dispatch("settings/load");
			await store.dispatch("users/getNewToken");
			await setLocale(store.state.settings.locale);

			// ask the server if we are logged in or not, and update the client to reflect that status.
			const resp = await API.get("/user");
			if (resp.data.loggedIn) {
				const user = resp.data;
				delete user.loggedIn;
				store.commit("LOGIN", user);
			}
		});

		const fullscreen = computed(() => store.state.fullscreen);

		return {
			showCreateRoomForm,
			showLogin,
			drawer,
			showCreateMenu,
			showMoreMenu,
			fullscreen,
			logout,
			setLocale,
			cancelRoom,
			createTempRoom,
			createPermanentRoom,
			openLogin,
			logoUrl,
			store,
			mdiBug,
			mdiHeart,
			mdiPlusBox,
			mdiMenu,
			mdiClose,
			mdiDotsHorizontal,
			mdiGithub,
		};
	},
});

// biome-ignore lint/nursery/noVueOptionsApi: TODO: convert to setup
export default App;
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: app-wide theme -->
<style lang="scss">
@use "./fonts.scss";
@use "./common.scss";
@use "./styles/cinema.scss";

.link {
	text-decoration: underline;
	cursor: pointer;
}
.link-invis {
	text-decoration: none;
	color: inherit !important;
}
.side-pad {
	margin: 0 4px;
}
.text-muted {
	opacity: 0.7;
}

.ott-app .ott-app-bar {
	border-bottom: 1px solid var(--line-strong);
	background: color-mix(in srgb, var(--background) 90%, transparent);
	backdrop-filter: blur(14px);
}
.nav-shell {
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	max-width: 1760px;
	padding: 0 24px;
	margin: 0 auto;
}
.nav-brand {
	display: flex;
	align-items: center;
	gap: 10px;
	flex: 0 1 auto;
	min-width: 0;
	color: var(--primary) !important;
	font-family: var(--font-display);
	font-size: 30px;
	font-weight: 400;
	line-height: 1;
	letter-spacing: 0.02em;
	text-shadow: var(--text-glow-primary);
}
.nav-brand img {
	flex-shrink: 0;
}
.nav-brand > span {
	min-width: 0;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.nav-links,
.nav-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}
.nav-links {
	margin-left: 16px;
}
.nav-links .v-btn--active {
	color: var(--primary);
}
.nav-actions {
	margin-left: auto;
	flex-shrink: 0;
}
.nav-create {
	margin-right: 8px;
}
.ott-app .nav-drawer {
	border-right: 1px solid var(--line-strong);
}
.drawer-heading,
.drawer-account {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 12px 16px;
}
.drawer-heading {
	color: var(--primary);
	border-bottom: 1px solid var(--line);
}
.drawer-divider {
	margin: 12px 4px;
}
.drawer-account {
	border-top: 1px solid var(--line);
	flex-wrap: wrap;
}
.overlay-loading-create-room {
	align-items: center;
	justify-content: center;
}
.room-creation-progress {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 24px;
	padding: 32px;
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-lg);
	background: var(--card);
	color: var(--foreground);
}
.skip-link {
	position: fixed;
	top: -100px;
	left: 12px;
	z-index: 5000;
	padding: 12px 20px;
	background: var(--primary);
	color: var(--primary-foreground) !important;
}
.skip-link:focus {
	top: 12px;
}

@media (max-width: 959px) {
	.nav-shell {
		gap: 4px;
		padding: 0 8px;
	}
	.nav-brand {
		gap: 8px;
		font-size: 26px;
	}
	.nav-brand img {
		width: 26px;
		height: 26px;
	}
	.nav-actions {
		gap: 0;
		min-width: 0;
	}
	.nav-actions > .v-btn {
		min-width: 48px;
		padding: 0 10px;
	}
}
@media (max-width: 359px) {
	.nav-brand {
		font-size: 23px;
	}
	.nav-brand img {
		display: none;
	}
}
</style>
