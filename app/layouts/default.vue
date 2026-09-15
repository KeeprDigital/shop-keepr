<script setup lang="ts">
/**
 * The sidebar shell (spec §8.1, _Shell_): collapsible left sidebar in the
 * spec's nav order, the single banner slot above the page, the `Cmd+K`
 * palette (page jump only for now), `/` to focus the page's search box.
 * The reprice indicator takes the sidebar footer later.
 */
const route = useRoute();
const searchBox = useSearchBox();

const navItems = computed(() => STAFF_NAV.map(item => ({
	label: item.label,
	icon: item.icon,
	to: item.to,
	active: item.to === '/' ? route.path === '/' : route.path.startsWith(item.to),
})));

const paletteGroups = computed(() => [{
	id: 'pages',
	label: 'Go to',
	items: STAFF_NAV.map(item => ({ label: item.label, icon: item.icon, to: item.to })),
}]);

async function signOut() {
	await authClient.signOut();
	await navigateTo('/login', { external: true });
}

// `Esc` is not bound here: every modal, slideover and menu is a Reka
// dismissable layer that closes itself, innermost first. A global handler
// would prevent default and the layer would then decline to dismiss.
defineShortcuts({
	'/': () => searchBox.value?.focus(),
});
</script>

<template>
	<UDashboardGroup>
		<UDashboardSidebar collapsible resizable :min-size="12" :default-size="16" :max-size="24">
			<template #header="{ collapsed }">
				<span class="font-semibold truncate" :class="collapsed && 'sr-only'">shop-keepr</span>
				<UDashboardSidebarCollapse v-if="!collapsed" class="ms-auto" />
			</template>

			<template #default="{ collapsed }">
				<UDashboardSearchButton :collapsed="collapsed" label="Jump to…" />
				<UNavigationMenu
					:collapsed="collapsed"
					:items="navItems"
					orientation="vertical"
					aria-label="Staff navigation"
				/>
			</template>

			<template #footer="{ collapsed }">
				<UButton
					:label="collapsed ? undefined : 'Sign out'"
					icon="i-lucide-log-out"
					color="neutral"
					variant="ghost"
					class="w-full"
					@click="signOut"
				/>
			</template>
		</UDashboardSidebar>

		<UDashboardSearch :groups="paletteGroups" :color-mode="false" placeholder="Jump to a page…" />

		<div class="flex flex-col flex-1 min-w-0">
			<StaffBanner />
			<slot />
		</div>
	</UDashboardGroup>
</template>
