import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { VueWrapper } from "@vue/test-utils";
import { Role } from "ott-common";
import { Grants } from "ott-common/permissions";
import PermissionsEditor from "@/components/PermissionsEditor.vue";
import { flush, mountComponent } from "./component-test-utils";

function permissionCheckbox(permission: string, role: Role) {
	return `[data-cy="perm-chk-${permission}-${role}"] input`;
}

/** Panels are lazy: a group's table only exists once the group has been opened. */
async function openGroup(wrapper: VueWrapper, key: string) {
	await wrapper.get(`[data-cy="perm-group-${key}"] .v-expansion-panel-title`).trigger("click");
	await nextTick();
	await flush();
}

describe("PermissionsEditor component", () => {
	it("labels permissions and groups in the UI language instead of internal identifiers", async () => {
		const { wrapper } = mountComponent(PermissionsEditor, {
			props: { modelValue: new Grants(), currentRole: 4 },
		});

		expect(wrapper.text()).toContain("用户管理");
		expect(wrapper.text()).toContain("高级：权限委派");

		await openGroup(wrapper, "playback");
		const text = wrapper.text();
		expect(text).toContain("播放 / 暂停");
		expect(text).not.toContain("playback.play-pause");
		expect(text).not.toContain("manage-users.kick");
	});

	it("collapses permission groups so the editor is not one long table", () => {
		const { wrapper } = mountComponent(PermissionsEditor, {
			props: { modelValue: new Grants(), currentRole: 4 },
		});

		expect(wrapper.find('[data-cy="perm-group-playback"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="perm-chk-playback.play-pause-0"]').exists()).toBe(false);
		expect(wrapper.find('[data-cy="perm-chk-manage-queue.add-0"]').exists()).toBe(false);
	});

	it("renders grants correctly", async () => {
		const grants = new Grants();
		grants.setRoleGrants(Role.UnregisteredUser, (1 << 0) | (1 << 1));
		const { wrapper } = mountComponent(PermissionsEditor, {
			props: { modelValue: grants, currentRole: 4 },
		});

		await openGroup(wrapper, "playback");
		expect(
			(
				wrapper.get(permissionCheckbox("playback.play-pause", Role.UnregisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.skip", Role.UnregisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.play-pause", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.skip", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.seek", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);

		grants.setRoleGrants(Role.UnregisteredUser, 1 << 0);
		grants.setRoleGrants(Role.RegisteredUser, 1 << 1);
		await wrapper.setProps({ modelValue: grants });

		expect(
			(
				wrapper.get(permissionCheckbox("playback.play-pause", Role.UnregisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.skip", Role.UnregisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.play-pause", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.skip", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.seek", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
	});

	it("handles clicking checkboxes", async () => {
		const grants = new Grants();
		grants.setRoleGrants(Role.UnregisteredUser, (1 << 0) | (1 << 1));
		const { wrapper } = mountComponent(PermissionsEditor, {
			props: { modelValue: grants, currentRole: 4 },
		});

		await openGroup(wrapper, "playback");
		await wrapper
			.get(permissionCheckbox("playback.play-pause", Role.UnregisteredUser))
			.trigger("click");
		expect(
			(
				wrapper.get(permissionCheckbox("playback.play-pause", Role.UnregisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(false);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.play-pause", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);

		await wrapper
			.get(permissionCheckbox("playback.skip", Role.UnregisteredUser))
			.trigger("click");
		expect(
			(
				wrapper.get(permissionCheckbox("playback.skip", Role.UnregisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(false);
		expect(
			(
				wrapper.get(permissionCheckbox("playback.skip", Role.RegisteredUser))
					.element as HTMLInputElement
			).checked,
		).toBe(true);
	});
});
