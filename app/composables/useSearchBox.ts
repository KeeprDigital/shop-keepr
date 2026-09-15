import type { Ref } from 'vue';

interface Focusable {
	focus: () => void;
}

/**
 * The page's search box, for the global `/` key (spec §8.1, _Global keys_).
 * A page with a search box registers it; the shell focuses whichever is
 * registered. The `UInput` ref exposes `inputRef`, the native element.
 */
export function useSearchBox() {
	return useState<Focusable | null>('staff-search-box', () => null);
}

export function registerSearchBox(input: Ref<{ inputRef?: HTMLInputElement | null } | null>) {
	const box = useSearchBox();
	watch(input, (component) => {
		box.value = component ? { focus: () => component.inputRef?.focus() } : null;
	}, { immediate: true });
	onBeforeUnmount(() => {
		box.value = null;
	});
}
