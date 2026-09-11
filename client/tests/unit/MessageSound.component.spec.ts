import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import type { ServerMessageChat } from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import Chat from "@/components/Chat.vue";
import ClientSettingsDialog from "@/components/ClientSettingsDialog.vue";
import { sfxInjectKey } from "@/plugins/sfx";
import { useStore } from "@/store";
import { mountComponent } from "./component-test-utils";

function receivedMessage(text: string): ServerMessageChat {
	return {
		action: "chat",
		from: {
			id: "sound-test-user",
			name: "Guest",
			isLoggedIn: false,
			status: PlayerStatus.ready,
			role: Role.UnregisteredUser,
		},
		text,
	};
}

function makeSound() {
	return { enabled: true, volume: ref(1), play: vi.fn().mockResolvedValue(undefined) };
}

describe("new message sound preferences", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("gates received sounds by the current setting while preserving messages and video volume", async () => {
		const sound = makeSound();
		const { wrapper, connection, store } = mountComponent(Chat, {
			global: { provide: { [sfxInjectKey as symbol]: sound } },
		});
		store.commit("settings/UPDATE", { volume: 37, muted: true });
		connection.mockReceive(receivedMessage("silent by default"));
		expect(sound.play).not.toHaveBeenCalled();

		store.commit("settings/UPDATE", { sfxEnabled: true });
		connection.mockReceive(receivedMessage("sound enabled"));
		expect(sound.play).toHaveBeenCalledOnce();
		expect(sound.play).toHaveBeenCalledWith("pop");

		store.commit("settings/UPDATE", { sfxEnabled: false });
		connection.mockReceive(receivedMessage("silent again"));
		expect(sound.play).toHaveBeenCalledOnce();
		await nextTick();
		expect(wrapper.findAll(".message")).toHaveLength(3);
		expect(store.state.settings.volume).toBe(37);
		expect(store.state.settings.muted).toBe(true);
	});

	it("syncs saved sound settings before the dialog opens and stops watching on unmount", async () => {
		const sound = makeSound();
		sound.enabled = false;
		const harness = defineComponent({
			components: { ClientSettingsDialog },
			setup() {
				useStore().commit("settings/UPDATE", {
					sfxEnabled: true,
					sfxVolume: 0.23,
					volume: 37,
					muted: true,
				});
			},
			template: "<ClientSettingsDialog />",
		});
		const { wrapper, store } = mountComponent(harness, {
			global: { provide: { [sfxInjectKey as symbol]: sound } },
		});
		expect(sound.enabled).toBe(true);
		expect(sound.volume.value).toBe(0.23);

		store.commit("settings/UPDATE", { sfxEnabled: false, sfxVolume: 0.65 });
		await nextTick();
		expect(sound.enabled).toBe(false);
		expect(sound.volume.value).toBe(0.65);
		expect(store.state.settings.volume).toBe(37);
		expect(store.state.settings.muted).toBe(true);

		wrapper.unmount();
		store.commit("settings/UPDATE", { sfxEnabled: true, sfxVolume: 0.14 });
		await nextTick();
		expect(sound.enabled).toBe(false);
		expect(sound.volume.value).toBe(0.65);
	});

	it("saves the personal new-message sound checkbox without altering video settings", async () => {
		const sound = makeSound();
		const { wrapper, store } = mountComponent(ClientSettingsDialog, {
			global: { provide: { [sfxInjectKey as symbol]: sound } },
		});
		store.commit("settings/UPDATE", { volume: 37, muted: true });
		await wrapper.get("button").trigger("click");
		await nextTick();
		const checkbox = document.querySelector<HTMLInputElement>(
			'[data-cy="chat-sound-enabled"] input',
		)!;
		expect(checkbox.checked).toBe(false);
		expect(checkbox.closest('[data-cy="chat-sound-enabled"]')?.textContent).toContain(
			"新消息提示音",
		);
		checkbox.click();
		await nextTick();
		const save = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".v-card-actions button"),
		).find(button => button.textContent?.trim() === "保存")!;
		save.click();
		await nextTick();
		expect(store.state.settings.sfxEnabled).toBe(true);
		expect(sound.enabled).toBe(true);
		expect(store.state.settings.volume).toBe(37);
		expect(store.state.settings.muted).toBe(true);
	});
});
