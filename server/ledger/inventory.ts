import type { SQL } from 'drizzle-orm';
/**
 * Inventory (spec §8.2, `/inventory`): "what do we hold". Every SKU with
 * stock on hand, joined to its Printing for display, filtered by Game
 * System and name, sorted by any column. Pinned rows join the list with
 * the pricing ticket, as does the name search's move onto the cascade.
 */
import type { InventoryPage, InventoryQuery, InventoryRow, InventorySort } from '../../shared/contracts/staff/inventory';
import type { Db } from '../db/client';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { CONDITIONS } from '../../shared/domain/condition';
import { printing, sku } from '../db/schema';
import { STORE_ID } from '../utils/store';

/** Condition sorts in grade order (NM first), not alphabetically. */
const conditionRank = sql`CASE ${sku.condition} ${sql.join(CONDITIONS.map((code, rank) => sql`WHEN ${code} THEN ${rank}`), sql` `)} END`;

const SORT_COLUMNS = {
	name: printing.name,
	setCode: printing.setCode,
	collectorNumber: printing.collectorNumber,
	condition: conditionRank,
	language: sku.language,
	onHand: sku.onHand,
	gameSystem: printing.gameSystem,
} satisfies Record<InventorySort, unknown>;

/** A substring match on the name, the typed wildcards taken literally; SQLite's LIKE has no escape unless told. */
function nameContains(q: string | undefined): SQL | undefined {
	const needle = q?.trim().toLowerCase();
	if (!needle) {
		return undefined;
	}
	const escaped = needle.replaceAll(/[%_\\]/g, char => `\\${char}`);
	return sql`lower(${printing.name}) LIKE ${`%${escaped}%`} ESCAPE '\\'`;
}

/** The stable order within a Printing, after whatever column leads. */
const TIE_BREAK = [asc(printing.name), asc(printing.setCode), asc(printing.collectorNumber), asc(conditionRank), asc(sku.language)];

export async function listInventory(db: Db, query: InventoryQuery): Promise<InventoryPage> {
	const inStock = and(eq(sku.storeId, STORE_ID), gt(sku.onHand, 0));
	const filters = [
		inStock,
		query.game ? eq(printing.gameSystem, query.game) : undefined,
		nameContains(query.q),
	];
	const lead = SORT_COLUMNS[query.sort ?? 'name'];
	const rows: InventoryRow[] = await db
		.select({
			skuId: sku.id,
			printingId: sku.printingId,
			gameSystem: printing.gameSystem,
			name: printing.name,
			setCode: printing.setCode,
			collectorNumber: printing.collectorNumber,
			finish: printing.finish,
			rarity: printing.rarity,
			condition: sku.condition,
			language: sku.language,
			onHand: sku.onHand,
			withdrawn: printing.withdrawn,
		})
		.from(sku)
		.innerJoin(printing, eq(printing.id, sku.printingId))
		.where(and(...filters))
		.orderBy(query.direction === 'desc' ? desc(lead) : asc(lead), ...TIE_BREAK);
	const games = await db
		.selectDistinct({ gameSystem: printing.gameSystem })
		.from(sku)
		.innerJoin(printing, eq(printing.id, sku.printingId))
		.where(inStock)
		.orderBy(asc(printing.gameSystem));
	return { rows, games: games.map(row => row.gameSystem) };
}
