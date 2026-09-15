<script setup lang="ts">
/** Lookup (spec §8.2): the counter's home. The search itself arrives with its ticket. */
const search = ref(null);
registerSearchBox(search);
</script>

<template>
	<StaffPage title="Lookup">
		<UInput
			ref="search"
			icon="i-lucide-search"
			placeholder="Search a card… (press / to focus)"
			size="lg"
			class="w-full max-w-xl"
			aria-label="Search"
		/>
	</StaffPage>
</template>
