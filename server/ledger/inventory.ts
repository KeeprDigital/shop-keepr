import type { SQL } from 'drizzle-orm';
/**
 * Inventory (spec §8.2, `/inventory`): "what do we hold". Every SKU with
 * stock on hand or a pinned price, joined to its Printing for display,
 * filtered by Game System and name, sorted by any column, the prices
 * from the stored columns (spec §6: stored so they sort and filter). The
 * name search's move onto the cascade is its own ticket.
 */
import type { InventoryPage, InventoryQuery, InventoryRow, InventorySort } from '../../shared/contracts/staff/inventory';
import type { Db } from '../db/client';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { CONDITIONS } from '../../shared/domain/condition';
import { printing, sku } from '../db/schema';
import { onHandOrPinned } from '../pricing/reprice';
import { readStoreSettings } from '../services/store';
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
	sellPrice: sku.sellPrice,
	buyPrice: sku.buyPrice,
	marketPrice: printing.marketPrice,
} satisfies Record<InventorySort, unknown>;

/** A price with nothing to say sorts after every number, whichever way the column runs. */
const NULLABLE_SORTS: readonly InventorySort[] = ['sellPrice', 'buyPrice', 'marketPrice'];

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
	const inStock = and(eq(sku.storeId, STORE_ID), onHandOrPinned());
	const filters = [
		inStock,
		query.game ? eq(printing.gameSystem, query.game) : undefined,
		nameContains(query.q),
	];
	const sort = query.sort ?? 'name';
	const lead = SORT_COLUMNS[sort];
	const leadOrder = [
		...(NULLABLE_SORTS.includes(sort) ? [sql`${lead} IS NULL`] : []),
		query.direction === 'desc' ? desc(lead) : asc(lead),
	];
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
			sellPrice: sku.sellPrice,
			sellPriceSource: sku.sellPriceSource,
			buyPrice: sku.buyPrice,
			buyPriceSource: sku.buyPriceSource,
			marketPrice: printing.marketPrice,
			marketPriceCurrency: printing.marketPriceCurrency,
			pricedAt: sku.pricedAt,
			withdrawn: printing.withdrawn,
		})
		.from(sku)
		.innerJoin(printing, eq(printing.id, sku.printingId))
		.where(and(...filters))
		.orderBy(...leadOrder, ...TIE_BREAK);
	const games = await db
		.selectDistinct({ gameSystem: printing.gameSystem })
		.from(sku)
		.innerJoin(printing, eq(printing.id, sku.printingId))
		.where(inStock)
		.orderBy(asc(printing.gameSystem));
	const { currency } = await readStoreSettings(db);
	return { rows, games: games.map(row => row.gameSystem), currency };
}
