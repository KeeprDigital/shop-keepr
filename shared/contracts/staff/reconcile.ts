/** What the reconcile job answers (spec §3, _Reconcile job_), by cron or from the System page. */
export interface Heal {
	skuId: string;
	storedOnHand: number;
	ledgerOnHand: number;
}

export interface ReconcileOutcome {
	/** SKU rows compared with the ledger. */
	checked: number;
	healed: Heal[];
}
