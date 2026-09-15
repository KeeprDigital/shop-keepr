<script setup lang="ts">
/**
 * Lookup (spec §8.2): the counter's home. A Game System selector
 * remembered per browser, the search box on the five-tier cascade, the
 * in-stock filter off by default, and filter controls built from the
 * vocabulary. One row per Printing with what is held. The card modal,
 * Sell and Buy, prices and the pin marker arrive with their tickets.
 */
import type { TableColumn } from '@nuxt/ui';
import type { SearchOptions, SearchPage, SearchRow } from '#shared/contracts/staff/search';

const search = ref(null);
registerSearchBox(search);

const game = useLocalStorage<string>('lookup-game', 'magic');
const q = ref('');
const inStock = ref(false);
const facets = ref<Record<string, string[]>>({});
const debouncedQ = refDebounced(q, 200);

watch(game, () => {
	facets.value = {};
});

const { data: options } = await useFetch<SearchOptions>('/api/staff/search/options', { query: computed(() => ({ game: game.value })) });

const gameItems = computed(() => (options.value?.games ?? [game.value]).map(code => ({ label: code, value: code })));

const query = computed(() => ({
	game: game.value,
	q: debouncedQ.value.trim() || undefined,
	inStock: inStock.value ? 'true' : undefined,
	...Object.fromEntries(Object.entries(facets.value).filter(([, values]) => values.length > 0).map(([facet, values]) => [`facet.${facet}`, values])),
}));

/** Lookup is a search, not a browse: nothing is fetched until a name is typed or a filter picked. */
const active = computed(() => query.value.q !== undefined || Object.keys(query.value).some(key => key.startsWith('facet.')));

const { data, status, execute, clear } = await useFetch<SearchPage>('/api/staff/search', { query, immediate: false, watch: false });

watch(query, () => (active.value ? execute() : clear()), { immediate: true });

/** A set control beside the vocabulary's Facets; every value list comes from the Mirror. */
const controls = computed(() => [
	{ facet: 'set', label: 'Set', items: (options.value?.sets ?? []).map(v => ({ label: v.name, value: v.code })) },
	...(options.value?.facets ?? []).map(f => ({ facet: f.facet, label: facetLabel(f.facet), items: f.values.map(v => ({ label: v.name, value: v.code })) })),
]);

function facetLabel(facet: string): string {
	const words = facet.replaceAll('_', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function selected(facet: string) {
	return computed({
		get: () => facets.value[facet] ?? [],
		set: (values: string[]) => {
			facets.value = { ...facets.value, [facet]: values };
		},
	});
}

const answeredBy = computed(() => data.value?.answeredBy ?? null);

const columns: TableColumn<SearchRow>[] = [
	{ id: 'thumbnail', header: '' },
	{ id: 'name', accessorKey: 'name', header: 'Printing' },
	{ id: 'rarity', accessorKey: 'rarity', header: 'Rarity' },
	{ id: 'held', accessorKey: 'held', header: 'Held', meta: { class: { td: 'text-right tabular-nums', th: 'text-right' } } },
	{ id: 'marketPrice', header: 'Market', meta: { class: { td: 'text-right tabular-nums', th: 'text-right' } } },
];

function money(row: SearchRow): string {
	if (row.marketPrice === null) {
		return '';
	}
	const amount = (row.marketPrice / 100).toFixed(2);
	return row.marketPriceCurrency ? `${amount} ${row.marketPriceCurrency}` : amount;
}
</script>

<template>
	<StaffPage title="Lookup">
		<div class="flex flex-wrap items-center gap-2 mb-3">
			<USelect v-model="game" :items="gameItems" aria-label="Game System" class="w-40" />
			<UInput
				ref="search"
				v-model="q"
				icon="i-lucide-search"
				placeholder="Search a card… (press / to focus)"
				size="lg"
				class="w-full max-w-xl"
				aria-label="Search"
			/>
			<USwitch v-model="inStock" label="In stock" />
		</div>

		<div class="flex flex-wrap items-center gap-2 mb-4">
			<USelectMenu
				v-for="control in controls"
				:key="`${game}-${control.facet}`"
				:model-value="selected(control.facet).value"
				:items="control.items"
				value-key="value"
				multiple
				:placeholder="control.label"
				:aria-label="control.label"
				class="w-44"
				@update:model-value="selected(control.facet).value = $event"
			/>
		</div>

		<p v-if="answeredBy === 'phonetic' || answeredBy === 'fuzzy'" class="text-xs text-muted mb-2">
			Showing the closest names.
		</p>

		<UTable
			:data="data?.rows ?? []"
			:columns="columns"
			:loading="status === 'pending'"
			:empty="q ? 'Nothing found in this game' : 'Type a name, or pick a filter'"
			aria-label="Results"
		>
			<template #thumbnail-cell="{ row }">
				<img v-if="row.original.thumbnail" :src="row.original.thumbnail" alt="" class="h-10 w-7 rounded object-cover bg-elevated">
			</template>
			<template #name-cell="{ row }">
				<div class="flex items-center gap-2">
					<div>
						<div class="font-medium text-highlighted">
							{{ row.original.name }}
						</div>
						<div class="text-xs text-muted">
							{{ row.original.setCode.toUpperCase() }}
							<template v-if="row.original.collectorNumber">
								#{{ row.original.collectorNumber }}
							</template>
							<template v-if="row.original.finish">
								· {{ row.original.finish }}
							</template>
						</div>
					</div>
					<UBadge v-if="row.original.withdrawn" label="Withdrawn" color="warning" variant="subtle" />
				</div>
			</template>
			<template #held-cell="{ row }">
				<span v-if="row.original.held > 0">{{ row.original.held }}</span>
				<span v-else class="text-muted">none held</span>
			</template>
			<template #marketPrice-cell="{ row }">
				{{ money(row.original) }}
			</template>
		</UTable>
	</StaffPage>
</template>
