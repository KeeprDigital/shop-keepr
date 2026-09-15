<script setup lang="ts">
/** One panel per page (spec §8.1): the navbar carries the title and the sidebar toggle. */
defineProps<{ title: string }>();
</script>

<template>
	<UDashboardPanel :id="title">
		<template #header>
			<UDashboardNavbar :title="title">
				<template #right>
					<slot name="actions" />
				</template>
			</UDashboardNavbar>
		</template>
		<template #body>
			<slot>
				<p class="text-sm text-muted">
					Nothing here yet.
				</p>
			</slot>
		</template>
	</UDashboardPanel>
</template>
