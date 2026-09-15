<script setup lang="ts">
/**
 * Inventory (spec §8.2, `/inventory`): "what do we hold". Every SKU with
 * stock on hand, filtered by Game System and name, sorted by any column,
 * with Adjust on the row. Held, prices, pins and the withdrawn-with-stock
 * chip join the table with their tickets.
 */
import type { TableColumn } from '@nuxt/ui';
import type { InventoryPage, InventoryRow, InventorySort } from '#shared/contracts/staff/inventory';
import { CONDITION_LABELS } from '#shared/domain/condition';

const search = ref(null);
registerSearchBox(search);

const q = ref('');
const game = ref<string | null>(null);
const sorting = ref<{ id: string; desc: boolean }[]>([{ id: 'name', desc: false }]);
const debouncedQ = refDebounced(q, 200);

const query = computed(() => ({
	q: debouncedQ.value.trim() || undefined,
	game: game.value ?? undefined,
	sort: (sorting.value[0]?.id ?? 'name') as InventorySort,
	direction: sorting.value[0]?.desc ? 'desc' : 'asc',
}));

const { data, status, refresh } = await useFetch<InventoryPage>('/api/staff/inventory', { query });

const gameItems = computed(() => [
	{ label: 'All games', value: null },
	...(data.value?.games ?? []).map(code => ({ label: code, value: code })),
]);

const UButton = resolveComponent('UButton');

function sortable(id: InventorySort, label: string): TableColumn<InventoryRow> {
	return {
		id,
		accessorKey: id,
		header: ({ column }) => {
			const sorted = column.getIsSorted();
			return h(UButton, {
				color: 'neutral',
				variant: 'ghost',
				label,
				icon: sorted ? (sorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
				class: '-mx-2.5',
				onClick: () => column.toggleSorting(sorted === 'asc'),
			});
		},
	};
}

const columns: TableColumn<InventoryRow>[] = [
	sortable('name', 'Printing'),
	sortable('condition', 'Condition'),
	sortable('language', 'Language'),
	{ ...sortable('onHand', 'On hand'), meta: { class: { td: 'text-right tabular-nums', th: 'text-right' } } },
	{ id: 'actions' },
];

const adjusting = ref<InventoryRow | null>(null);
const adjustOpen = ref(false);

function adjust(row: InventoryRow) {
	adjusting.value = row;
	adjustOpen.value = true;
}
</script>

<template>
	<StaffPage title="Inventory">
		<div class="flex flex-wrap items-center gap-2 mb-4">
			<UInput
				ref="search"
				v-model="q"
				icon="i-lucide-search"
				placeholder="Search by name… (press / to focus)"
				class="w-full max-w-sm"
				aria-label="Search"
			/>
			<USelect v-model="game" :items="gameItems" aria-label="Game System" class="w-44" />
		</div>

		<UTable
			v-model:sorting="sorting"
			:data="data?.rows ?? []"
			:columns="columns"
			:sorting-options="{ manualSorting: true }"
			:loading="status === 'pending'"
			empty="Nothing on hand matches"
			aria-label="Inventory"
		>
			<template #name-cell="{ row }">
				<div class="flex items-center gap-2">
					<div>
						<div class="font-medium text-highlighted">
							{{ row.original.name }}
						</div>
						<div class="text-xs text-muted">
							{{ row.original.gameSystem }} · {{ row.original.setCode.toUpperCase() }}
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
			<template #condition-cell="{ row }">
				<span :title="CONDITION_LABELS[row.original.condition]">{{ row.original.condition }}</span>
			</template>
			<template #actions-cell="{ row }">
				<UButton label="Adjust" icon="i-lucide-sliders-horizontal" color="neutral" variant="outline" size="sm" @click="adjust(row.original)" />
			</template>
		</UTable>

		<AdjustModal v-model:open="adjustOpen" :sku="adjusting" @adjusted="refresh()" />
	</StaffPage>
</template>
