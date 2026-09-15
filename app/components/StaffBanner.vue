<script setup lang="ts">
const banner = useBanner();
</script>

<template>
	<UAlert
		v-if="banner"
		:title="banner.title"
		:description="banner.description"
		:color="banner.color"
		variant="subtle"
		class="rounded-none"
		:actions="banner.to ? [{ label: 'Open System', to: banner.to, color: 'neutral', variant: 'link' }] : []"
	/>
</template>
