/**
 * The sidebar, in the spec's order (§8.1, _Nav order and routes_): a guess
 * at counter frequency, so Lookup first and the landing page. Badges
 * (uncommitted Transaction lines, submitted Baskets, committing sessions,
 * stale pins) arrive with the tickets that produce them.
 */
export interface StaffNavItem {
	label: string;
	to: string;
	icon: string;
}

export const STAFF_NAV: readonly StaffNavItem[] = [
	{ label: 'Lookup', to: '/', icon: 'i-lucide-search' },
	{ label: 'Transaction', to: '/transaction', icon: 'i-lucide-arrow-left-right' },
	{ label: 'Queue', to: '/queue', icon: 'i-lucide-shopping-basket' },
	{ label: 'Customer Lists', to: '/lists', icon: 'i-lucide-list-checks' },
	{ label: 'Large Buy', to: '/large-buy', icon: 'i-lucide-package-plus' },
	{ label: 'Ingest', to: '/ingest', icon: 'i-lucide-package-open' },
	{ label: 'Inventory', to: '/inventory', icon: 'i-lucide-boxes' },
	{ label: 'Pinned Prices', to: '/pinned', icon: 'i-lucide-pin' },
	{ label: 'History', to: '/history', icon: 'i-lucide-history' },
	{ label: 'Settings', to: '/settings', icon: 'i-lucide-settings' },
	{ label: 'System', to: '/system', icon: 'i-lucide-activity' },
];
