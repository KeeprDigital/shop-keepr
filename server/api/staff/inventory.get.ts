import * as z from 'zod';
import { INVENTORY_SORTS } from '../../../shared/contracts/staff/inventory';
import { listInventory } from '../../ledger/inventory';

const zInventoryQuery = z.object({
	game: z.string().trim().min(1).optional(),
	q: z.string().trim().max(200).optional(),
	sort: z.enum(INVENTORY_SORTS).optional(),
	direction: z.enum(['asc', 'desc']).optional(),
});

export default defineEventHandler(event => listInventory(useDb(event), validateQuery(event, zInventoryQuery)));
