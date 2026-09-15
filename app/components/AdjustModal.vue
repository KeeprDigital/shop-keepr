<script setup lang="ts">
/**
 * The Adjust modal (spec §8.2, _Adjust modal_): the SKU fixed from the
 * row; a delta, a new count, or a regrade to another Condition; a Reason
 * from the modal's list; an optional note. Writes one Adjustment.
 */
import type { FormSubmitEvent } from '@nuxt/ui';
import type { AdjustmentRequest, AdjustmentResponse } from '#shared/contracts/staff/adjustment';
import type { InventoryRow } from '#shared/contracts/staff/inventory';
import type { Condition } from '#shared/domain/condition';
import * as z from 'zod';
import { CONDITION_LABELS, CONDITIONS } from '#shared/domain/condition';
import { COUNT_CHANGE_REASONS, REASON_LABELS } from '#shared/domain/ledger';

const props = defineProps<{ sku: InventoryRow | null }>();
const emit = defineEmits<{ adjusted: [result: AdjustmentResponse] }>();
const open = defineModel<boolean>('open', { default: false });

type Mode = 'delta' | 'newCount' | 'regrade';

const MODES: { value: Mode; label: string; description: string }[] = [
	{ value: 'delta', label: 'Change by', description: 'Add or remove copies' },
	{ value: 'newCount', label: 'New count', description: 'What the shelf shows' },
	{ value: 'regrade', label: 'Regrade', description: 'Move copies to another Condition' },
];

const schema = z.object({
	mode: z.enum(['delta', 'newCount', 'regrade']),
	quantity: z.number().int('Whole copies only'),
	regradeTo: z.enum(CONDITIONS).optional(),
	reason: z.enum(COUNT_CHANGE_REASONS).optional(),
	note: z.string().trim().max(500).optional(),
}).check((ctx) => {
	const { mode, quantity, regradeTo, reason } = ctx.value;
	if (mode === 'delta' && quantity === 0) {
		ctx.issues.push({ code: 'custom', message: 'A change moves at least one copy', path: ['quantity'], input: quantity });
	}
	if (mode === 'newCount' && quantity < 0) {
		ctx.issues.push({ code: 'custom', message: 'A count is never below zero', path: ['quantity'], input: quantity });
	}
	if (mode === 'regrade' && quantity < 1) {
		ctx.issues.push({ code: 'custom', message: 'A regrade moves at least one copy', path: ['quantity'], input: quantity });
	}
	if (mode === 'regrade' && !regradeTo) {
		ctx.issues.push({ code: 'custom', message: 'Choose the Condition the copies are now', path: ['regradeTo'], input: regradeTo });
	}
	if (mode !== 'regrade' && !reason) {
		ctx.issues.push({ code: 'custom', message: 'Choose a Reason', path: ['reason'], input: reason });
	}
});
type Schema = z.output<typeof schema>;

const blank = (): Partial<Schema> => ({ mode: 'delta', quantity: undefined, regradeTo: undefined, reason: undefined, note: '' });
const state = reactive<Partial<Schema>>(blank());
const failure = ref<string | null>(null);
const submitting = ref(false);
const toast = useToast();

watch(open, (isOpen) => {
	if (isOpen) {
		Object.assign(state, blank());
		failure.value = null;
	}
});

const quantityLabel = computed(() => MODES.find(mode => mode.value === state.mode)?.label ?? 'Quantity');

const regradeTargets = computed(() => CONDITIONS
	.filter(code => code !== props.sku?.condition)
	.map(code => ({ value: code, label: `${CONDITION_LABELS[code]} (${code})` })));

const reasons = COUNT_CHANGE_REASONS.map(reason => ({ value: reason, label: REASON_LABELS[reason] }));

function toRequest(sku: InventoryRow, data: Schema): AdjustmentRequest {
	const key = { printingId: sku.printingId, condition: sku.condition, language: sku.language };
	const note = data.note || undefined;
	switch (data.mode as Mode) {
		case 'regrade':
			return { ...key, change: { delta: data.quantity }, regradeTo: data.regradeTo as Condition, reason: 'condition-regrade', note };
		case 'newCount':
			return { ...key, change: { newCount: data.quantity }, reason: data.reason!, note };
		default:
			return { ...key, change: { delta: data.quantity }, reason: data.reason!, note };
	}
}

async function onSubmit({ data }: FormSubmitEvent<Schema>) {
	if (!props.sku) {
		return;
	}
	failure.value = null;
	submitting.value = true;
	try {
		const result = await $fetch<AdjustmentResponse>('/api/staff/adjustments', { method: 'POST', body: toRequest(props.sku, data) });
		toast.add({ title: 'Adjustment recorded', description: `${props.sku.name} · ${props.sku.condition} · now ${result.lines[0]?.onHand ?? 0} on hand`, color: 'success' });
		emit('adjusted', result);
		open.value = false;
	}
	catch (error) {
		failure.value = describeFailure(error);
	}
	finally {
		submitting.value = false;
	}
}

function describeFailure(error: unknown): string {
	const data = (error as { data?: { data?: { code?: string; details?: { available?: number } } } })?.data?.data;
	if (data?.code === 'INSUFFICIENT_STOCK') {
		return `Only ${data.details?.available ?? 0} on hand; stock cannot go below zero`;
	}
	if (data?.code === 'VALIDATION_FAILED') {
		return 'The Adjustment was not accepted; check the fields';
	}
	if (data?.code === 'UNAUTHENTICATED') {
		return 'Signed out; sign in again to record it';
	}
	return 'The Adjustment could not be recorded';
}
</script>

<template>
	<UModal
		v-model:open="open"
		title="Adjust stock"
		:description="sku ? `${sku.name} · ${sku.setCode.toUpperCase()} ${sku.collectorNumber ?? ''} · ${CONDITION_LABELS[sku.condition]} (${sku.condition}) · ${sku.language} · ${sku.onHand} on hand` : ''"
		:ui="{ footer: 'justify-end' }"
	>
		<template #body>
			<UForm id="adjust-form" :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
				<UFormField name="mode" label="Change">
					<URadioGroup v-model="state.mode" :items="MODES" orientation="horizontal" variant="table" />
				</UFormField>

				<UFormField name="quantity" :label="quantityLabel" required>
					<UInputNumber v-model="state.quantity" :min="state.mode === 'delta' ? undefined : 0" :aria-label="quantityLabel" class="w-40" />
				</UFormField>

				<UFormField v-if="state.mode === 'regrade'" name="regradeTo" label="Now in Condition" required>
					<USelect v-model="state.regradeTo" :items="regradeTargets" placeholder="Choose a Condition" aria-label="Now in Condition" class="w-64" />
				</UFormField>

				<UFormField v-if="state.mode === 'regrade'" label="Reason">
					<p class="text-sm text-muted">
						{{ REASON_LABELS['condition-regrade'] }}
					</p>
				</UFormField>
				<UFormField v-else name="reason" label="Reason" required>
					<USelect v-model="state.reason" :items="reasons" placeholder="Choose a Reason" aria-label="Reason" class="w-64" />
				</UFormField>

				<UFormField name="note" label="Note" hint="Optional">
					<UTextarea v-model="state.note" :rows="2" class="w-full" aria-label="Note" />
				</UFormField>

				<UAlert v-if="failure" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="failure" />
			</UForm>
		</template>

		<template #footer="{ close }">
			<UButton label="Cancel" color="neutral" variant="outline" @click="close" />
			<UButton type="submit" form="adjust-form" label="Record Adjustment" :loading="submitting" />
		</template>
	</UModal>
</template>
