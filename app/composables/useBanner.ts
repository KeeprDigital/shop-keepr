export interface Banner {
	/** Why the counter should look up from the page. */
	title: string;
	description?: string;
	color: 'warning' | 'error' | 'info';
	/** Where the banner sends staff, System for sync trouble (spec §8.1). */
	to?: string;
}

/**
 * The shell's one banner slot (spec §8.1, _Banner slot_). Whoever has
 * something to say sets it; Catalogue staleness or drift wins over a
 * reprice in progress, which the sync and pricing tickets arbitrate when
 * they arrive. Nothing sets it yet.
 */
export function useBanner() {
	return useState<Banner | null>('staff-banner', () => null);
}
