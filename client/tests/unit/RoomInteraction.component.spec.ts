import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Room from "@/views/Room.vue";
import Chat from "@/components/Chat.vue";
import VideoSettings from "@/components/controls/VideoSettings.vue";
import { usePlaybackRate } from "@/components/composables";
import { OttSfx } from "@/plugins/sfx";
import { RoomRequestType } from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import { mountComponent } from "./component-test-utils";

describe("room player interactions", () => {
	let page: ReturnType<typeof mountComponent>;
	beforeEach(async () => {
		vi.useFakeTimers();
		const saved = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
			removeItem: (key: string) => saved.delete(key),
			clear: () => saved.clear(),
			key: (index: number) => Array.from(saved.keys())[index] ?? null,
			get length() {
				return saved.size;
			},
		});
		localStorage.setItem("token", "component-test-token");
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		vi.spyOn(OttSfx.prototype, "loadSfx").mockResolvedValue(undefined);
		page = mountComponent(Room, {
			global: {
				stubs: {
					OmniPlayer: true,
					VideoQueue: true,
					AddPreview: true,
					UserList: true,
					RoomSettingsForm: true,
					ShareInvite: true,
					ClientSettingsDialog: true,
					RoomDisconnected: true,
					ServerMessageHandler: true,
					WorkaroundPlaybackStatusUpdater: true,
					WorkaroundUserStateNotifier: true,
					RestoreQueue: true,
					VoteSkip: true,
				},
			},
		});
		page.connection.connected.value = true;
		page.connection.active.value = true;
		page.store.commit("room/SYNC", {
			currentSource: {
				service: "direct",
				id: "https://example.test/03.mp4",
				title: "示例剧集",
				length: 600,
			},
			isPlaying: true,
			playbackPosition: 100,
			playbackSpeed: 1,
		});
		page.store.state.room.grants.setRoleGrants(Role.UnregisteredUser, [
			"playback.speed",
			"playback.seek",
			"playback.play-pause",
		]);
		page.store.commit("users/SET_YOU", { info: { id: "alice" } });
		page.store.commit("users/INIT_USERS", [
			{
				id: "alice",
				name: "Alice",
				role: Role.UnregisteredUser,
				isLoggedIn: false,
				status: PlayerStatus.ready,
			},
		]);
		page.store.commit("PLAYBACK_STATUS", PlayerStatus.ready);
		usePlaybackRate().availablePlaybackRates.value = [1, 1.5, 2];
		await nextTick();
		await vi.advanceTimersByTimeAsync(250);
	});
	afterEach(() => {
		page?.wrapper.unmount();
		localStorage.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function pointer(type: string, x = 200, y = 150) {
		const target = page.wrapper.get('[data-cy="player-gesture-surface"]')
			.element as HTMLElement;
		target.getBoundingClientRect = () =>
			({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 }) as DOMRect;
		const event = new MouseEvent(type, {
			clientX: x,
			clientY: y,
			button: 0,
			bubbles: true,
			cancelable: true,
		});
		Object.assign(event, { pointerType: "touch", pointerId: 1, isPrimary: true });
		target.dispatchEvent(event);
	}
	async function tap() {
		pointer("pointerdown");
		pointer("pointerup");
		await nextTick();
	}
	function key(code: string, target: EventTarget = document.body) {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				code,
				key: code === "Escape" ? "Escape" : undefined,
				bubbles: true,
				cancelable: true,
			}),
		);
	}

	function stubFullscreen(mode: string, target: HTMLElement) {
		const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
		const originalExit = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
		let nativeElement: Element | null = null;
		Object.defineProperty(document, "fullscreenElement", {
			configurable: true,
			get: () => nativeElement,
		});
		Object.defineProperty(document, "exitFullscreen", {
			configurable: true,
			value: vi.fn(async () => {
				nativeElement = null;
				document.dispatchEvent(new Event("fullscreenchange"));
			}),
		});
		if (mode === "native") {
			Object.defineProperty(target, "requestFullscreen", {
				configurable: true,
				value: vi.fn(async () => {
					nativeElement = target;
					document.dispatchEvent(new Event("fullscreenchange"));
				}),
			});
		}
		return {
			exit() {
				if (mode === "native") {
					// The browser can exit native fullscreen independently of our own button.
					nativeElement = null;
					document.dispatchEvent(new Event("fullscreenchange"));
				} else {
					key("KeyF");
				}
			},
			restore() {
				if (originalFullscreen) {
					Object.defineProperty(document, "fullscreenElement", originalFullscreen);
				} else {
					Reflect.deleteProperty(document, "fullscreenElement");
				}
				if (originalExit) {
					Object.defineProperty(document, "exitFullscreen", originalExit);
				} else {
					Reflect.deleteProperty(document, "exitFullscreen");
				}
			},
		};
	}

	it("shows the episode and toggles controls without pausing playback", async () => {
		expect(page.wrapper.get('[data-cy="now-playing"]').text()).toContain("第 3 集");
		await tap();
		expect(page.wrapper.get(".video-controls").attributes("inert")).toBeDefined();
		expect(page.wrapper.find('[data-cy="now-playing"]').exists()).toBe(false);
		await tap();
		expect(page.wrapper.get(".video-controls").attributes("inert")).toBeUndefined();
		expect(page.connection.sent).toEqual([]);
		expect(page.store.state.room.isPlaying).toBe(true);
	});

	it("keeps reading chat visible and lets a picture tap close it without losing the draft", async () => {
		await page.wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const input = page.wrapper.get('[data-cy="chat-input"] input');
		expect(document.activeElement).not.toBe(input.element);
		await input.setValue("稍后再发");
		await vi.advanceTimersByTimeAsync(4000);
		expect(page.wrapper.find(".chat.activated").exists()).toBe(true);
		expect(page.wrapper.get(".video-controls").classes()).not.toContain("hide");
		await tap();
		expect(page.wrapper.find(".chat.activated").exists()).toBe(false);
		expect(page.wrapper.get(".video-controls").classes()).toContain("hide");
		await tap();
		await page.wrapper.get('[data-cy="chat-activate"]').trigger("click");
		expect(
			(page.wrapper.get('[data-cy="chat-input"] input').element as HTMLInputElement).value,
		).toBe("稍后再发");
		expect(page.connection.sent).toEqual([]);
	});

	it("commits one room seek only after releasing a swipe", async () => {
		const position = page.wrapper.vm.truePosition;
		pointer("pointerdown");
		pointer("pointermove", 260);
		await nextTick();
		expect(page.connection.sent).toEqual([]);
		expect(page.wrapper.get(".player-gesture-hint").text()).toContain("松手跳转");
		pointer("pointerup", 260);
		await nextTick();
		expect(page.connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.SeekRequest, value: position + 10 } },
		]);
	});

	it("ends a held speed on losing window focus without also tapping the picture", async () => {
		pointer("pointerdown");
		await vi.advanceTimersByTimeAsync(500);
		const start = page.connection.sent[0] as any;
		expect(start.request.type).toBe(RoomRequestType.TemporaryPlaybackSpeedRequest);
		expect(start.request.action).toBe("start");
		window.dispatchEvent(new Event("blur"));
		pointer("pointerup");
		expect(page.connection.sent).toEqual([
			start,
			{ action: "req", request: { ...start.request, action: "stop" } },
		]);
	});

	it("keeps shortcuts working after source changes and does not steal typed characters", async () => {
		key("KeyT");
		await nextTick();
		const input = page.wrapper.get('[data-cy="chat-input"] input');
		expect(document.activeElement).not.toBe(input.element);
		key("KeyK", input.element);
		expect(page.connection.sent).toEqual([]);
		key("KeyT");
		await nextTick();
		expect(page.wrapper.find('[data-cy="chat-input"]').exists()).toBe(false);
		page.store.commit("room/SYNC", {
			currentSource: { service: "youtube", id: "test-episode", title: "EP04", length: 600 },
		});
		await nextTick();
		key("KeyT");
		await nextTick();
		expect(page.wrapper.find('[data-cy="chat-input"]').exists()).toBe(true);
		key("KeyT");
		await nextTick();
		key("KeyF");
		await nextTick();
		expect(page.store.state.fullscreen).toBe(true);
		key("KeyT");
		await nextTick();
		expect(page.wrapper.find('[data-cy="chat-input"]').exists()).toBe(true);
		key("KeyT");
		await nextTick();
		key("KeyF");
		await nextTick();
		key("KeyK");
		expect(page.connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.PlaybackRequest, state: false } },
		]);
	});

	it("exposes the swipe interval in player settings and keeps the menu visible while reading", async () => {
		const settings = page.wrapper.findComponent(VideoSettings);
		await settings.get("button").trigger("click");
		await vi.advanceTimersByTimeAsync(4000);
		expect(page.wrapper.get(".video-controls").classes()).not.toContain("hide");
		await settings.findAll(".swipe-step-options button")[2].trigger("click");
		expect(page.store.state.settings.swipeSeekSeconds).toBe(30);
		key("Escape");
		await nextTick();
		expect(settings.find(".settings-menu-container").exists()).toBe(false);
	});

	it.each([
		"fallback",
		"native",
	])("preserves one chat, its history and draft across %s fullscreen and source changes", async mode => {
		const target = page.wrapper.get(".video-subcontainer").element as HTMLElement;
		const fullscreen = stubFullscreen(mode, target);

		try {
			page.store.commit("room/SYNC", {
				currentSource: {
					service: "youtube",
					id: "test-episode",
					title: "EP04",
					length: 600,
				},
			});
			await nextTick();
			key("KeyT");
			await nextTick();
			const input = page.wrapper.get('[data-cy="chat-input"] input');
			await input.setValue("切换布局后继续发送");
			const receive = async (text: string) => {
				page.connection.mockReceive({
					action: "chat",
					from: {
						id: "alice",
						name: "Alice",
						isLoggedIn: false,
						status: PlayerStatus.ready,
						role: Role.UnregisteredUser,
					},
					text,
				});
				await nextTick();
			};
			await receive("较早的消息");
			await vi.advanceTimersByTimeAsync(20001);
			await receive("刚收到的消息");
			const chat = page.wrapper.get(".chat").element;
			const chatInstance = page.wrapper.findComponent(Chat).vm;
			const addHandler = vi.spyOn(page.connection, "addMessageHandler");
			const removeHandler = vi.spyOn(page.connection, "removeMessageHandler");
			const messages = page.wrapper.get(".messages");
			Object.defineProperty(messages.element, "scrollHeight", {
				configurable: true,
				value: 400,
			});
			Object.defineProperty(messages.element, "clientHeight", {
				configurable: true,
				value: 100,
			});
			messages.element.scrollTop = 80;
			await messages.trigger("scroll");
			const expected = ["较早的消息", "刚收到的消息"];
			const expectPreserved = (container: string) => {
				expect(page.wrapper.get(`${container} .chat`).element).toBe(chat);
				expect(page.wrapper.findAllComponents(Chat)).toHaveLength(1);
				expect(page.wrapper.findComponent(Chat).vm).toBe(chatInstance);
				expect(page.wrapper.get(".chat").classes()).toContain("activated");
				expect(page.wrapper.vm.chatOpen).toBe(true);
				expect(
					page.wrapper.findAll(".message .text").map(message => message.text()),
				).toEqual(expected);
				expect(
					(page.wrapper.get('[data-cy="chat-input"] input').element as HTMLInputElement)
						.value,
				).toBe("切换布局后继续发送");
				expect(document.activeElement).not.toBe(input.element);
				expect(messages.element.scrollTop).toBe(80);
			};
			expectPreserved(".out-video-chat");
			key("KeyF");
			await nextTick();
			expect(page.store.state.fullscreen).toBe(true);
			expectPreserved(".in-video-chat");
			await receive("全屏内的新消息");
			expected.push("全屏内的新消息");
			fullscreen.exit();
			await nextTick();
			expect(page.store.state.fullscreen).toBe(false);
			expectPreserved(".out-video-chat");
			page.store.commit("room/SYNC", {
				currentSource: {
					service: "direct",
					id: "https://example.test/05.mp4",
					length: 600,
				},
			});
			await nextTick();
			expectPreserved(".in-video-chat");
			page.store.commit("room/SYNC", {
				currentSource: { service: "youtube", id: "test-episode-6", length: 600 },
			});
			await nextTick();
			await receive("切换来源后的消息");
			expected.push("切换来源后的消息");
			expectPreserved(".out-video-chat");
			expect(addHandler.mock.calls.filter(([action]) => action === "chat")).toHaveLength(0);
			expect(removeHandler.mock.calls.filter(([action]) => action === "chat")).toHaveLength(
				0,
			);
		} finally {
			page.wrapper.unmount();
			fullscreen.restore();
		}
	});
});
