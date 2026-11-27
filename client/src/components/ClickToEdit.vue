<template>
	<div style="display: inline-flex">
		<div v-if="editing">
			<v-text-field
				variant="solo"
				hide-details
				density="compact"
				single-line
				class="editor"
				ref="editor"
				v-model="valueDirty"
				@keyup.enter="apply"
				@keyup.esc="abortAndRestoreFocus"
				@blur="abort"
			/>
		</div>
		<!-- Button semantics on a div: the editor replaces this element, and a native
		     button would change the inline layout the timestamp relies on. -->
		<div
			v-else
			@click="activate"
			@keydown="onDisplayKeydown"
			@keyup="onDisplayKeyup"
			class="editable"
			ref="display"
			role="button"
			tabindex="0"
		>
			{{ typeof modelValue === "number" ? valueFormatter(modelValue) : modelValue }}
		</div>
	</div>
</template>

<script lang="ts" setup generic="T extends string | number">
/**
 * Provides a value display that can be clicked to edit.
 */
import { ref, nextTick, type Ref } from "vue";

const props = withDefaults(
	defineProps<{
		valueFormatter?: (value: number) => string;
		valueParser?: (value: string) => number;
	}>(),
	{
		valueFormatter: (value: number): string => value.toString(),
		valueParser: (value: string): number => parseInt(value, 10),
	},
);

const model = defineModel<T>();

const emit = defineEmits<{
	change: [value: T];
}>();

const editor = ref<HTMLInputElement | undefined>();
const valueFormatter = ref(props.valueFormatter) as Ref<(value: number) => string>;
const valueParser = ref(props.valueParser) as Ref<(value: string) => number>;

const editing = ref(false);
const valueDirty = ref("");
const display: Ref<HTMLDivElement | undefined> = ref();
const editorWidth = ref(120);

/**
 * Activation waits for keyup. Focusing the editor on keydown let the same Enter keyup land
 * in the text field, whose own keyup.enter applies — closing the editor the user just opened.
 */
function onDisplayKeydown(e: KeyboardEvent) {
	if (e.key === " " || e.key === "Spacebar") {
		// A focused div scrolls the page on Space; a button must not.
		e.preventDefault();
	}
}

function onDisplayKeyup(e: KeyboardEvent) {
	if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
		e.preventDefault();
		void activate();
	}
}

async function activate() {
	if (display.value) {
		editorWidth.value = display.value.offsetWidth + 24;
	}
	if (typeof model.value === "number") {
		valueDirty.value = valueFormatter.value(model.value);
	} else {
		valueDirty.value = model.value ?? "";
	}
	editing.value = true;
	await nextTick();
	editor.value?.focus();
}

function apply() {
	let outValue: T;
	if (typeof model.value === "number") {
		outValue = valueParser.value(valueDirty.value) as T;
	} else {
		outValue = valueDirty.value as T;
	}
	editing.value = false;
	model.value = outValue;
	emit("change", outValue);
	void restoreDisplayFocus();
}

function abort() {
	editing.value = false;
}

/** Escape is a keyboard exit, so the display takes focus back for the next Tab. */
function abortAndRestoreFocus() {
	abort();
	void restoreDisplayFocus();
}

async function restoreDisplayFocus() {
	await nextTick();
	display.value?.focus();
}
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.editor {
	width: 10ch;
}

.editable {
	cursor: pointer;
	user-select: none;

	&:focus-visible {
		outline: 2px solid rgb(var(--v-theme-primary));
		outline-offset: 2px;
		border-radius: 3px;
	}
}
</style>
