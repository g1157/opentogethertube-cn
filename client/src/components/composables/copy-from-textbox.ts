import { type Ref, ref, type ComputedRef } from "vue";

export function useCopyFromTextbox(
	text: Ref<string> | ComputedRef<string>,
	textboxComponent: Ref<any>,
) {
	let copySuccessTimeoutId: ReturnType<typeof setTimeout> | null = null;
	const copySuccess = ref(false);

	async function copy(): Promise<void> {
		if (navigator.clipboard) {
			try {
				await navigator.clipboard.writeText(text.value);
			} catch (err) {
				console.error("Failed to copy invite link", err);
				return;
			}
		} else {
			const textfield: HTMLInputElement | HTMLTextAreaElement | null = (
				textboxComponent.value.$el as HTMLInputElement | HTMLTextAreaElement
			).querySelector("input, textarea");
			if (!textfield) {
				console.error("failed to copy link: input not found");
				return;
			}
			textfield.select();
			if (!document.execCommand("copy")) {
				console.error("failed to copy link: execCommand returned false");
				return;
			}
			textfield.blur();
		}
		if (copySuccessTimeoutId) {
			clearTimeout(copySuccessTimeoutId);
		}
		copySuccessTimeoutId = setTimeout(() => {
			copySuccess.value = false;
		}, 3000);
		copySuccess.value = true;
	}

	return {
		copySuccess,
		copy,
	};
}
