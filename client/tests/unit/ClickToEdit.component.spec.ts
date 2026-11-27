import { describe, expect, it, vi } from "vitest";
import ClickToEdit from "@/components/ClickToEdit.vue";
import { mountComponent } from "./component-test-utils";

describe("ClickToEdit component", () => {
	it("renders .editable", () => {
		const { wrapper } = mountComponent(ClickToEdit);

		expect(wrapper.find(".editable").exists()).toBe(true);
		expect(wrapper.get(".editable").classes()).toContain("editable");
	});

	it("renders a string", () => {
		const { wrapper } = mountComponent(ClickToEdit, { props: { modelValue: "Hello World" } });

		expect(wrapper.get(".editable").text()).toContain("Hello World");
	});

	it("can edit a string", async () => {
		const changeSpy = vi.fn();
		const updateModelValueSpy = vi.fn();
		const { wrapper } = mountComponent(ClickToEdit, {
			props: {
				modelValue: "Hello World",
				onChange: changeSpy,
				"onUpdate:modelValue": updateModelValueSpy,
			},
		});

		await wrapper.get(".editable").trigger("click");
		await wrapper.get("input").setValue("foo");
		await wrapper.get("input").trigger("keyup.enter");

		expect(changeSpy).toHaveBeenCalledWith("foo");
		expect(updateModelValueSpy).toHaveBeenCalledWith("foo");
	});

	it("does not edit when escape is pressed or focus is lost", async () => {
		const changeSpy = vi.fn();
		const updateModelValueSpy = vi.fn();
		const { wrapper } = mountComponent(ClickToEdit, {
			props: {
				modelValue: "Hello World",
				onChange: changeSpy,
				"onUpdate:modelValue": updateModelValueSpy,
			},
		});

		await wrapper.get(".editable").trigger("click");
		await wrapper.get("input").setValue("foo");
		await wrapper.get("input").trigger("keyup.esc");
		await wrapper.vm.$nextTick();
		await wrapper.get(".editable").trigger("click");
		await wrapper.get("input").setValue("foo");
		await wrapper.get("input").trigger("blur");

		expect(changeSpy).not.toHaveBeenCalled();
		expect(updateModelValueSpy).not.toHaveBeenCalled();
	});

	it("renders and edits a number", async () => {
		const changeSpy = vi.fn();
		const updateModelValueSpy = vi.fn();
		const { wrapper } = mountComponent(ClickToEdit, {
			props: {
				modelValue: 420,
				onChange: changeSpy,
				"onUpdate:modelValue": updateModelValueSpy,
			},
		});

		expect(wrapper.get(".editable").text()).toContain("420");
		await wrapper.get(".editable").trigger("click");
		await wrapper.get("input").setValue("123");
		await wrapper.get("input").trigger("keyup.enter");

		expect(changeSpy).toHaveBeenCalledWith(123);
		expect(updateModelValueSpy).toHaveBeenCalledWith(123);
	});

	it("exposes the display as a keyboard reachable button", () => {
		const { wrapper } = mountComponent(ClickToEdit, { props: { modelValue: "Hello World" } });
		const display = wrapper.get(".editable");

		expect(display.attributes("role")).toBe("button");
		expect(display.attributes("tabindex")).toBe("0");
		expect(display.element.tagName).toBe("DIV");
	});

	it.each([
		["Enter", "Enter"],
		["Space", " "],
	])("opens the editor from %s and focuses the input", async (_label, key) => {
		const { wrapper } = mountComponent(ClickToEdit, { props: { modelValue: "Hello World" } });
		const display = wrapper.get(".editable");
		(display.element as HTMLElement).focus();

		await display.trigger("keyup", { key });
		await wrapper.vm.$nextTick();

		const input = wrapper.get("input");
		expect(document.activeElement).toBe(input.element);
	});

	it("keeps the editor open for typing after activation from the keyboard", async () => {
		const { wrapper } = mountComponent(ClickToEdit, { props: { modelValue: "Hello World" } });
		const display = wrapper.get(".editable");

		// The Enter that opens the editor must not reach the input's own apply handler.
		await display.trigger("keyup", { key: "Enter" });
		await wrapper.vm.$nextTick();
		expect(wrapper.find("input").exists()).toBe(true);
	});

	it("gives focus back to the display after escape", async () => {
		const { wrapper } = mountComponent(ClickToEdit, { props: { modelValue: "Hello World" } });
		const display = wrapper.get(".editable");

		await display.trigger("keyup", { key: "Enter" });
		await wrapper.vm.$nextTick();
		await wrapper.get("input").trigger("keyup.esc");
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();

		expect(document.activeElement).toBe(wrapper.get(".editable").element);
	});
});
