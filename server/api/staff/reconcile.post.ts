import { reconcileOnHand } from '../../ledger/reconcile';

/** The reconcile job on demand, from the System page (spec §3, _Reconcile job_). */
export default defineEventHandler(event => reconcileOnHand(useDb(event)));
