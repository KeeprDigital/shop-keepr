<script setup lang="ts">
/**
 * System (spec §8.2, `/system`): the sync and health surface, arriving
 * with its tickets. For now, the reconcile job on demand (spec §3,
 * _Reconcile job_): heals `on_hand` from the ledger and says what it healed.
 */
import type { ReconcileOutcome } from '#shared/contracts/staff/reconcile';

const outcome = ref<ReconcileOutcome | null>(null);
const running = ref(false);
const failed = ref(false);

async function reconcile() {
	running.value = true;
	failed.value = false;
	try {
		outcome.value = await $fetch<ReconcileOutcome>('/api/staff/reconcile', { method: 'POST' });
	}
	catch {
		failed.value = true;
	}
	finally {
		running.value = false;
	}
}
</script>

<template>
	<StaffPage title="System">
		<UCard>
			<template #header>
				<h2 class="font-semibold">
					Stock reconcile
				</h2>
			</template>
			<p class="text-sm text-muted mb-3">
				Compares every SKU's on-hand with the ledger, heals any that differ, and records each heal. Runs hourly on its own.
			</p>
			<UButton label="Reconcile now" icon="i-lucide-scale" :loading="running" @click="reconcile" />
			<UAlert v-if="failed" class="mt-3" color="error" variant="subtle" title="The reconcile could not run" />
			<UAlert
				v-else-if="outcome"
				class="mt-3"
				:color="outcome.healed.length ? 'warning' : 'success'"
				variant="subtle"
				:title="outcome.healed.length ? `Healed ${outcome.healed.length} of ${outcome.checked} SKUs` : `Checked ${outcome.checked} SKUs; all agree with the ledger`"
			/>
		</UCard>
	</StaffPage>
</template>
