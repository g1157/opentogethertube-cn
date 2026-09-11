import { afterEach, describe, it, expect, vi } from "vitest";
import { KeyboardShortcuts } from "../../src/util/keyboard-shortcuts";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

describe("KeyboardShortcuts", () => {
	afterEach(() => {
		document.onkeydown = null;
		document.body.innerHTML = "";
	});

	it.each([
		{ metaKey: true },
		{ altKey: true },
		{ ctrlKey: true },
		{ isComposing: true },
		{ keyCode: 229 },
		{ repeat: true },
	])("does not hijack a browser/input combination %s", modifiers => {
		const shortcuts = new KeyboardShortcuts();
		const action = vi.fn();
		shortcuts.bind({ code: "KeyK" }, action);
		const event = new KeyboardEvent("keydown", {
			code: "KeyK",
			cancelable: true,
			...modifiers,
		});
		shortcuts.handleKeyDown(event);
		expect(action).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});
	it.each([
		'<div contenteditable="true"><span>text</span></div>',
		"<button><span>button</span></button>",
		"<select></select>",
		'<div role="slider"><span>slider</span></div>',
		'<a href="#"><span>link</span></a>',
	])("preserves keyboard behavior of interactive elements: %s", html => {
		document.body.innerHTML = html;
		const shortcuts = new KeyboardShortcuts();
		const action = vi.fn();
		shortcuts.bind({ code: "KeyK" }, action);
		document.onkeydown = event => shortcuts.handleKeyDown(event);
		const target = document.querySelector("span") ?? document.body.firstElementChild!;
		target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", bubbles: true }));
		expect(action).not.toHaveBeenCalled();
	});
	it("does not trigger behind a modal and allows explicit repeat for seek keys", () => {
		const shortcuts = new KeyboardShortcuts();
		const action = vi.fn();
		shortcuts.bind({ code: "ArrowRight", repeat: true }, action);
		document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
		shortcuts.handleKeyDown(new KeyboardEvent("keydown", { code: "ArrowRight" }));
		expect(action).not.toHaveBeenCalled();
		document.body.innerHTML = "";
		shortcuts.handleKeyDown(new KeyboardEvent("keydown", { code: "ArrowRight", repeat: true }));
		expect(action).toHaveBeenCalledOnce();
	});
	it("should bind and unbind", () => {
		const shortcuts = new KeyboardShortcuts();
		const binding = { code: "KeyA" };
		const action = vi.fn();

		shortcuts.bind(binding, action);
		shortcuts.handleKeyDown(new KeyboardEvent("keydown", binding));
		expect(action).toHaveBeenCalledTimes(1);

		shortcuts.unbind(binding);
		shortcuts.handleKeyDown(new KeyboardEvent("keydown", binding));
		expect(action).toHaveBeenCalledTimes(1);
	});

	it("should bind multiple bindings for the same action", () => {
		const shortcuts = new KeyboardShortcuts();
		const binding = [{ code: "KeyA" }, { code: "KeyB" }];
		const action = vi.fn();

		shortcuts.bind(binding, action);
		shortcuts.handleKeyDown(
			new KeyboardEvent("keydown", {
				code: "KeyA",
			}),
		);
		shortcuts.handleKeyDown(
			new KeyboardEvent("keydown", {
				code: "KeyB",
			}),
		);
		expect(action).toHaveBeenCalledTimes(2);
	});

	it("should not bind duplicate bindings", () => {
		const shortcuts = new KeyboardShortcuts();
		const binding = { code: "KeyA" };
		const action = vi.fn();

		shortcuts.bind(binding, action);
		shortcuts.bind(binding, action);
		expect(shortcuts.shortcuts.length).toBe(1);
	});

	it("should only match the key combo", () => {
		const shortcuts = new KeyboardShortcuts();
		const bindBad = { code: "KeyA" };
		const bindGood = { code: "KeyA", ctrlKey: true };
		const actionBad = vi.fn();
		const actionGood = vi.fn();

		shortcuts.bind(bindBad, actionBad);
		shortcuts.bind(bindGood, actionGood);
		shortcuts.handleKeyDown(
			new KeyboardEvent("keydown", {
				code: "KeyA",
				ctrlKey: true,
			}),
		);
		expect(actionBad).toHaveBeenCalledTimes(0);
		expect(actionGood).toHaveBeenCalledTimes(1);
	});

	it.each([
		"input",
		"textarea",
	])("should not match any bindings when an element of type %s is focused", (nodeName: string) => {
		const shortcuts = new KeyboardShortcuts();
		const binding = { code: "KeyA" };
		const action = vi.fn();
		const onkeydownInvoke = vi.fn();

		function doOnKeyDown() {
			onkeydownInvoke();
			shortcuts.handleKeyDown(event);
		}
		document.onkeydown = doOnKeyDown;
		const element = document.createElement(nodeName);
		element.onkeydown = doOnKeyDown;
		document.body.appendChild(element);
		shortcuts.bind(binding, action);
		const event = new KeyboardEvent("keydown", {
			code: "KeyA",
		});
		document.dispatchEvent(event);
		element.dispatchEvent(event);
		expect(action).toHaveBeenCalledTimes(1);
		expect(onkeydownInvoke).toHaveBeenCalledTimes(2);
	});

	it("should automatically unbind keys when the calling component is unmounted", () => {
		const shortcuts = new KeyboardShortcuts();
		const binding = { code: "KeyA" };
		const action = vi.fn();

		const component = defineComponent({
			setup() {
				shortcuts.bind(binding, action);
				return h("div");
			},
		});
		const wrapper = mount(component);

		shortcuts.handleKeyDown(new KeyboardEvent("keydown", binding));
		expect(action).toHaveBeenCalledTimes(1);

		wrapper.unmount();
		shortcuts.handleKeyDown(new KeyboardEvent("keydown", binding));
		expect(action).toHaveBeenCalledTimes(1);
	});
});
