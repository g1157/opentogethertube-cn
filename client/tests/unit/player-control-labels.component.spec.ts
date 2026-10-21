import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import BasicControls from "@/components/controls/BasicControls.vue";
import Room from "@/views/Room.vue";
import { PlayerActionsKey } from "@/util/player-actions";
import { Role } from "ott-common/models/types";
import { mountComponent } from "./component-test-utils";

/**
 * The rewind/skip buttons, the arrow keys and the swipe gesture have to agree on one
 * step: the label used to claim 10 seconds while the room moved by the configured
 * step (7 by default).
 */
describe("player control labels", () => {
	function mountControls() {
		const seek = vi.fn();
		const page = mountComponent(BasicControls, {
			props: { currentPosition: 100 },
			global: {
				provide: {
					[PlayerActionsKey as symbol]: {
						playbackBlocked: ref(false),
						togglePlayback: vi.fn(),
						seek,
					},
				},
			},
		});
		page.store.state.room.grants.setRoleGrants(Role.UnregisteredUser, [
			"playback.seek",
			"playback.play-pause",
		]);
		return { ...page, seek };
	}

	it("names the rewind and skip buttons after the configured step", () => {
		const { wrapper } = mountControls();
		const buttons = wrapper.findAll("button");
		const rewind = buttons.find(b => b.attributes("aria-label")?.includes("7"));
		const skip = buttons.find(b => b.attributes("aria-label")?.includes("前进"));
		expect(rewind?.attributes("aria-label")).toBe("后退 7 秒");
		expect(skip?.attributes("aria-label")).toBe("前进 7 秒");
	});

	it("jumps by the configured step instead of a hardcoded ten seconds", async () => {
		const { wrapper, store, seek } = mountControls();
		store.commit("room/SYNC", {
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
		await wrapper.vm.$nextTick();
		const buttons = wrapper.findAll("button");
		const rewind = buttons.find(b => b.attributes("aria-label")?.includes("后退"));
		await rewind?.trigger("click");
		expect(seek).toHaveBeenCalledWith(93);
	});
});

/**
 * Below 960px the tab captions are hidden and only the icons stay visible, so the tabs
 * have to carry their name in an attribute instead.
 */
describe("room tab names", () => {
	beforeEach(() => {
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
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("names the queue, add and settings tabs", () => {
		const page = mountComponent(Room, {
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
		const tabs = page.wrapper.findAll('[role="tab"]');
		const names = tabs.map(tab => tab.attributes("aria-label"));
		expect(names).toContain("队列");
		expect(names).toContain("添加");
		expect(names).toContain("设置");
	});
});
