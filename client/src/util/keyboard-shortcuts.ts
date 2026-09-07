import { getCurrentInstance, inject, type InjectionKey, onUnmounted } from "vue";
import _ from "lodash";

const BINDING_DEFAULTS = {
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	metaKey: false,
	repeat: false,
};

export class KeyboardShortcuts {
	shortcuts: [KeyBindingStrict, (event: KeyboardEvent) => void][] = [];

	bind(binding: KeyBinding | KeyBinding[], action: (event: KeyboardEvent) => void) {
		if (Array.isArray(binding)) {
			for (const b of binding) {
				this.bind(b, action);
			}
		} else {
			const bindStrict: KeyBindingStrict = _.defaults({ ...binding }, BINDING_DEFAULTS);

			// don't allow duplicate bindings
			for (const [b] of this.shortcuts) {
				if (_.isEqual(b, bindStrict)) {
					console.warn("duplicate keyboard shortcut binding", bindStrict);
					return;
				}
			}

			this.shortcuts.push([bindStrict, action]);

			if (getCurrentInstance()) {
				onUnmounted(() => {
					this.unbind(binding);
				});
			}
		}
	}

	unbind(binding: KeyBinding) {
		const bindStrict: KeyBindingStrict = _.defaults({ ...binding }, BINDING_DEFAULTS);

		this.shortcuts = this.shortcuts.filter(s => {
			return !_.isEqual(s[0], bindStrict);
		});
	}

	handleKeyDown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
			return;
		}
		if (
			document.querySelector(
				'.v-dialog.v-overlay--active, .v-menu.v-overlay--active, [role="dialog"][aria-modal="true"], dialog[open]',
			)
		) {
			return;
		}
		if (event.target instanceof Element) {
			if (
				event.target.closest(
					'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="button"], [role="menu"], [data-player-shortcuts="off"]',
				)
			) {
				return;
			}
		}

		for (const [binding, action] of this.shortcuts) {
			if (this.eventMatches(event, binding)) {
				event.preventDefault();
				action(event);
				return;
			}
		}
	}

	private eventMatches(event: KeyboardEvent, binding: KeyBindingStrict) {
		return (
			event.code === binding.code &&
			event.ctrlKey === binding.ctrlKey &&
			event.shiftKey === binding.shiftKey &&
			event.altKey === binding.altKey &&
			event.metaKey === binding.metaKey &&
			(!event.repeat || binding.repeat)
		);
	}
}

export const RoomKeyboardShortcutsKey: InjectionKey<KeyboardShortcuts> = Symbol("room:keyboard");

interface KeyBinding {
	shiftKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	repeat?: boolean;
	code: string;
}

interface KeyBindingStrict {
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	repeat: boolean;
	code: string;
}

export function useRoomKeyboardShortcuts(): KeyboardShortcuts | undefined {
	return inject(RoomKeyboardShortcutsKey);
}
