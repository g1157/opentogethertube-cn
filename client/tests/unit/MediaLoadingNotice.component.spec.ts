import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaLoadingNotice from "@/components/players/MediaLoadingNotice.vue";
import { mountComponent } from "./component-test-utils";

describe("media loading notice", () => {
	let page: ReturnType<typeof mountComponent> | undefined;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
	});
	afterEach(() => {
		page?.wrapper.unmount();
		page = undefined;
		vi.useRealTimers();
	});

	function mountNotice() {
		page = mountComponent(MediaLoadingNotice, {
			props: {
				state: { phase: "preparing", currentTime: null, bufferAhead: null },
				roomPlaying: true,
				canRetry: true,
			},
		});
		return page.wrapper;
	}

	it("shows elapsed waiting time and an indeterminate bar, without an invented completion estimate", async () => {
		const wrapper = mountNotice();
		expect(wrapper.find('[data-cy="media-loading-notice"]').exists()).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.text()).toContain("正在准备视频");
		expect(wrapper.text()).toContain("已等待 1 秒");
		expect(wrapper.text()).toContain("画面准备好后会自动跟上");
		expect(wrapper.get('[role="progressbar"]').attributes("aria-valuenow")).toBeUndefined();
		expect(wrapper.text()).not.toContain("NaN");
		expect(wrapper.find('[data-cy="retry-loading-media"]').exists()).toBe(false);
	});

	it("keeps one waiting clock across preparation, seeking and buffering, then offers a local retry", async () => {
		const wrapper = mountNotice();
		await vi.advanceTimersByTimeAsync(9000);
		await wrapper.setProps({
			state: { phase: "seeking", currentTime: 310, bufferAhead: 0 },
		});
		await vi.advanceTimersByTimeAsync(2000);
		await wrapper.setProps({
			state: { phase: "buffering", currentTime: 310, bufferAhead: 3.79 },
		});
		await vi.advanceTimersByTimeAsync(4000);
		expect(wrapper.text()).toContain("已等待 15 秒");
		expect(wrapper.text()).toContain("已缓存 3.7 秒");
		expect(wrapper.text()).toContain("加载时间较长");
		await wrapper.get('[data-cy="retry-loading-media"]').trigger("click");
		expect(wrapper.emitted("retry")).toHaveLength(1);
	});

	it("does not show invalid buffer values or an unsupported retry action", async () => {
		const wrapper = mountNotice();
		await wrapper.setProps({
			state: { phase: "waiting-frame", currentTime: 310, bufferAhead: Infinity },
			roomPlaying: false,
			canRetry: false,
		});
		await vi.advanceTimersByTimeAsync(15000);
		expect(wrapper.text()).toContain("正在等待画面");
		expect(wrapper.text()).toContain("视频画面准备好后会自动显示");
		expect(wrapper.text()).not.toContain("已缓存");
		expect(wrapper.find('[data-cy="retry-loading-media"]').exists()).toBe(false);
	});

	it("stops the waiting clock when removed", () => {
		const before = vi.getTimerCount();
		const wrapper = mountNotice();
		expect(vi.getTimerCount()).toBe(before + 1);
		wrapper.unmount();
		expect(vi.getTimerCount()).toBe(before);
	});

	it("explains why viewers wait together at the saved position", async () => {
		const wrapper = mountNotice();
		await wrapper.setProps({ roomPlaying: false, resuming: true });
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.text()).toContain("画面准备好后再开始计时");
		await wrapper.setProps({
			state: { phase: "waiting-frame", currentTime: 310, bufferAhead: 4 },
			resuming: false,
			waitingForViewer: true,
		});
		expect(wrapper.text()).toContain("等待首位观众准备好");
		expect(wrapper.text()).toContain("首位观众准备好后大家一起播放");
	});

	it("offers an immediate retry after failed preparation instead of an endless progress bar", async () => {
		const wrapper = mountNotice();
		await wrapper.setProps({ roomPlaying: false, preparationFailed: true });
		await vi.advanceTimersByTimeAsync(500);
		expect(wrapper.text()).toContain("恢复播放需要重试");
		expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
		await wrapper.get('[data-cy="retry-loading-media"]').trigger("click");
		expect(wrapper.emitted("retry")).toHaveLength(1);
	});
});
