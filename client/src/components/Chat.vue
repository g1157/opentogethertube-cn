<template>
	<div
		:class="{
			'chat': true,
			'activated': activated,
			'controls-hidden': !controlsVisible,
		}"
	>
		<div class="chat-header" v-if="activated">
			<v-btn
				icon
				size="x-small"
				@click="setActivated(false)"
				data-cy="chat-deactivate"
				:aria-label="$t('chat.close')"
			>
				<v-icon :icon="mdiChevronDown" />
			</v-btn>
			<h4>{{ $t("chat.title") }}</h4>
		</div>
		<div ref="messages" @scroll="onScroll" class="messages grow">
			<div class="grow"><!-- Spacer --></div>
			<transition-group name="message">
				<ChatMsg
					v-for="entry in chatMessages"
					:key="entry.id"
					:msg="entry.message"
					:recent="isRecent(entry)"
					@link-click="emit('link-click', $event)"
				/>
			</transition-group>
		</div>
		<div v-if="!stickToBottom" class="to-bottom">
			<v-btn size="x-small" icon @click="forceToBottom">
				<v-icon :icon="mdiChevronDoubleDown" />
			</v-btn>
		</div>
		<Transition name="input" @after-enter="enforceStickToBottom">
			<div class="input-box" v-if="activated">
				<v-text-field
					variant="solo"
					density="compact"
					single-line
					:placeholder="$t('chat.type-here')"
					@keydown="onInputKeyDown"
					@compositionstart="composing = true"
					@compositionend="composing = false"
					v-model="inputValue"
					autocomplete="off"
					ref="chatInput"
					data-cy="chat-input"
				/>
			</div>
		</Transition>
		<div class="manual-activate" v-if="!activated">
			<v-btn
				variant="text"
				icon
				size="x-small"
				@click="setActivated(true)"
				color="white"
				data-cy="chat-activate"
				:aria-label="$t('chat.open')"
			>
				<v-icon :icon="mdiCommentOutline" />
			</v-btn>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { mdiChevronDown, mdiChevronDoubleDown, mdiCommentOutline } from "@mdi/js";
import { computed, onUpdated, ref, type Ref, nextTick, onMounted, onUnmounted, watch } from "vue";
import type { ChatMessage } from "ott-common/models/types";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import type { ServerMessageChat } from "ott-common/models/messages";
import { useSfx } from "@/plugins/sfx";
import { useStore } from "@/store";
import ChatMsg from "./ChatMsg.vue";

const props = withDefaults(defineProps<{ controlsVisible?: boolean; draft?: string }>(), {
	controlsVisible: true,
});
const emit = defineEmits(["link-click", "activation-change", "update:draft"]);

const connection = useConnection();
const roomapi = useRoomApi(connection);
const store = useStore();
const overlayDurationMs = computed(() => store.state.settings.chatOverlaySeconds * 1000);

const localDraft = ref("");
function updateDraft(draft: string) {
	localDraft.value = draft;
	emit("update:draft", draft);
}
const inputValue = computed({
	get: () => props.draft ?? localDraft.value,
	set: updateDraft,
});
const composing = ref(false);
const stickToBottom = ref(true);
/**
 * When chat is activated, all messages are shown. and the
 * user can scroll through message history, type in chat, etc.
 * When chat is NOT activated, when messages are received,
 * they appear for the configured duration, measured from receipt.
 */
const activated = ref(false);
interface ReceivedChatMessage {
	id: number;
	message: ChatMessage;
	receivedAt: number;
}
// Expiring the overlay never removes messages from the expanded chat history.
const chatMessages = ref<ReceivedChatMessage[]>([]);
const visibilityTime = ref(Date.now());
let nextMessageId = 0;
let expirationTimer: ReturnType<typeof setTimeout> | undefined;
const messages = ref();
const chatInput: Ref<HTMLInputElement | undefined> = ref();
let focusRequest = 0;
let disposed = false;

onMounted(() => {
	connection.addMessageHandler("chat", onChatReceived);
});

onUnmounted(() => {
	disposed = true;
	focusRequest++;
	connection.removeMessageHandler("chat", onChatReceived);
	clearTimeout(expirationTimer);
	emit("activation-change", false);
});

function setActivated(value: boolean): void {
	if (disposed) {
		return;
	}
	focusRequest++;
	activated.value = value;
	emit("activation-change", value);
	if (value) {
		// Opening chat to read must not raise the mobile keyboard.
		void nextTick(enforceStickToBottom);
	} else {
		chatInput.value?.blur();
		composing.value = false;
		forceToBottom();
	}
}

function activateAndFocus(): void {
	setActivated(true);
	const request = focusRequest;
	void nextTick().then(() => {
		if (!disposed && activated.value && request === focusRequest) {
			chatInput.value?.focus();
		}
	});
}

defineExpose({ setActivated, activateAndFocus, activated });

const sfx = useSfx();
function onChatReceived(msg: ServerMessageChat): void {
	chatMessages.value.push({ id: nextMessageId++, message: msg, receivedAt: Date.now() });
	updateMessageVisibility();
	nextTick(enforceStickToBottom);
	if (store.state.settings.sfxEnabled) {
		void sfx.play("pop");
	}
}

function isRecent(entry: ReceivedChatMessage): boolean {
	return (
		overlayDurationMs.value > 0 &&
		entry.receivedAt + overlayDurationMs.value > visibilityTime.value
	);
}

function updateMessageVisibility() {
	clearTimeout(expirationTimer);
	expirationTimer = undefined;
	visibilityTime.value = Date.now();
	const next = chatMessages.value.find(isRecent);
	if (next) {
		expirationTimer = setTimeout(
			updateMessageVisibility,
			next.receivedAt + overlayDurationMs.value - visibilityTime.value,
		);
	}
}

// Apply duration changes to message ages, rather than restarting their countdowns.
watch(overlayDurationMs, updateMessageVisibility);

/**
 * Performs the necessary actions to enact the stickToBottom behavior.
 */
function enforceStickToBottom() {
	const div = messages.value as HTMLDivElement;
	if (!div) {
		return;
	}
	if (stickToBottom.value) {
		div.scrollTop = div.scrollHeight;
	}
}

function onInputKeyDown(e: KeyboardEvent): void {
	if (
		!activated.value ||
		disposed ||
		e.defaultPrevented ||
		composing.value ||
		e.isComposing ||
		e.keyCode === 229 ||
		e.ctrlKey ||
		e.altKey ||
		e.metaKey ||
		e.shiftKey
	) {
		return;
	}
	const submit = e.key === "Enter" || e.code === "NumpadEnter";
	if (!submit && e.key !== "Escape") {
		return;
	}
	e.preventDefault();
	e.stopPropagation();
	if (e.repeat) {
		return;
	}
	if (submit) {
		if (inputValue.value.trim() !== "") {
			roomapi.chat(inputValue.value);
		}
		inputValue.value = "";
		stickToBottom.value = true;
		setActivated(false);
	} else {
		setActivated(false);
	}
}

function onScroll() {
	const div = messages.value as HTMLDivElement;
	if (!div) {
		return;
	}
	const distToBottom = div.scrollHeight - div.clientHeight - div.scrollTop;
	stickToBottom.value = distToBottom === 0;
}

function forceToBottom() {
	stickToBottom.value = true;
	enforceStickToBottom();
}

onUpdated(enforceStickToBottom);
</script>

<style lang="scss" scoped>
.chat {
	display: flex;
	flex-direction: column;
	margin: 4px;
	padding: 3px;
	transition: all 0.2 ease;
	pointer-events: none;
	height: 100%;

	&.activated {
		background: rgba(var(--v-theme-background), $alpha: 0.8);
		pointer-events: auto;
	}

	&.controls-hidden:not(.activated) .manual-activate {
		visibility: hidden;
		pointer-events: none;
	}
}

.activated {
	.message {
		opacity: 1;

		&.recent {
			background: transparent;
			transition-duration: 0.2s;
		}
	}

	.messages {
		overflow-y: auto;
		pointer-events: auto;
	}
}

.chat-header {
	display: flex;
	flex-direction: row;
	align-items: center;
	border-bottom: 1px solid #666;
}

.input-box {
	display: flex;
	justify-self: end;
	flex-shrink: 1;
	height: 40px;
}

.grow {
	display: flex;
	flex-grow: 1;
}

.messages {
	display: flex;
	flex-direction: column;
	flex-basis: 0;

	margin-top: 8px;

	overflow: hidden;
	pointer-events: none;

	align-items: baseline;
}

.manual-activate {
	display: flex;
	align-self: flex-end;
	justify-self: end;
	pointer-events: auto;
}

.to-bottom {
	display: flex;
	justify-content: start;
	width: 100%;
	pointer-events: auto;
	margin: 6px 0;
	position: absolute;
	bottom: 42px;
	z-index: 100;
}

// Transition animation
.message-enter-active,
.message-leave-active {
	transition: all 0.2s;
}
.message-enter,
.message.leave-to {
	opacity: 0;
	transform: translateX(-30px) scaleY(0);
}
.message-move {
	transition: transform 0.2s;
}

.input-enter-active,
.input-leave-active {
	transition: all 0.2s ease;
}
.input-enter,
.input-leave-to {
	opacity: 0;
	transform: translateY(-30px) scaleY(0);
	height: 0;
}
</style>
