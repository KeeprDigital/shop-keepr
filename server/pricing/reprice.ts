import type { Condition } from '../../shared/domain/condition';
import type { Language } from '../../shared/domain/language';
/**
 * Repricing stored SKU rows (spec §6, _Stored SKU prices and recompute_):
 * the one routine the sweep and the inline recompute share. Given SKU
 * rows as read with their Printing, it runs the evaluator per side and
 * writes the prices back, each row's update guarded in SQL (ADR 0011): it
 * applies only while `on_hand` and both sources still read as they did,
 * so a pin placed meanwhile stands and a ledger append that repriced the
 * row itself is not overwritten with a stale number. A row whose Printing
 * has no Market Price, or no exchange rate to convert at, takes a null
 * price and a fresh `priced_at`: it was evaluated, and there was nothing
 * to say. `priced_at` is the Market Price watermark, so only a pass that
 * evaluated the Sell side moves it: a Buy-only recompute after a ledger
 * append leaves it where it was, and a Market Price that moved meanwhile
 * still reaches the row on the next watermark sweep (spec §6: a missed
 * reprice self-heals, the watermark stays behind).
 */
import type { Money } from '../../shared/domain/money';
import type { PriceSource } from '../../shared/domain/reprice';
import type { Side } from '../../shared/pricing/settings';
import type { Db } from '../db/client';
import type { PricingAttributes } from '../search/pricing-attributes';
import type { PricingContext } from './context';
import { eq, gt, inArray, or, sql } from 'drizzle-orm';
import { evaluatePrice } from '../../shared/pricing/evaluate';
import { printing, sku } from '../db/schema';
import { prepared } from '../ledger/statement';
import { readPricingAttributes } from '../search/pricing-attributes';
import { fxRateFor } from './context';

/** D1 binds 100 parameters per statement (spec §4.1); an id list is read in slices under it. */
const ID_SLICE = 90;

function slices<T>(items: readonly T[], size = ID_SLICE): T[][] {
	const out: T[][] = [];
	for (let at = 0; at < items.length; at += size) {
		out.push(items.slice(at, at + size));
	}
	return out;
}

/** A SKU held or pinned: what Inventory lists and the sweep visits (spec §6: scope `on_hand > 0 OR pinned`). */
export function onHandOrPinned() {
	return or(gt(sku.onHand, 0), eq(sku.sellPriceSource, 'pinned'), eq(sku.buyPriceSource, 'pinned'));
}

/** What the evaluator needs of a SKU, held or not: its key, its stock and its Printing's Market Price. */
export interface PriceInput {
	printingId: string;
	gameSystem: string;
	condition: Condition;
	language: Language;
	onHand: number;
	marketPrice: number | null;
	marketPriceCurrency: string | null;
	sellPriceSource: PriceSource;
	buyPriceSource: PriceSource;
}

/** A stored SKU row with what the evaluator needs from its Printing. */
export interface SkuPriceRow extends PriceInput {
	id: string;
}

export const SKU_PRICE_COLUMNS = {
	id: sku.id,
	printingId: sku.printingId,
	gameSystem: printing.gameSystem,
	condition: sku.condition,
	language: sku.language,
	onHand: sku.onHand,
	marketPrice: printing.marketPrice,
	marketPriceCurrency: printing.marketPriceCurrency,
	sellPriceSource: sku.sellPriceSource,
	buyPriceSource: sku.buyPriceSource,
};

/** The Pricing Attribute values of every Printing the rows name, by Printing. */
export async function attributesFor(db: Db, rows: readonly { printingId: string; gameSystem: string }[]): Promise<Map<string, PricingAttributes>> {
	const byGame = new Map<string, string[]>();
	for (const row of rows) {
		const ids = byGame.get(row.gameSystem) ?? [];
		if (!ids.includes(row.printingId)) {
			ids.push(row.printingId);
		}
		byGame.set(row.gameSystem, ids);
	}
	return readPricingAttributes(db.$client, byGame);
}

/** The SKU rows with their Printings, the base every reprice reads from. */
export function skuPriceRows(db: Db) {
	return db.select(SKU_PRICE_COLUMNS).from(sku).innerJoin(printing, eq(printing.id, sku.printingId));
}

/** One side's price through the evaluator, at quantity 1 under the on-hand given; null when nothing converts. */
export function priceSide(ctx: PricingContext, row: PriceInput, attributes: PricingAttributes, side: Side, quantity = 1): Money | null {
	const fxRate = fxRateFor(ctx, row.marketPriceCurrency);
	if (row.marketPrice === null || fxRate === null) {
		return null;
	}
	return evaluatePrice(ctx.settings, {
		side,
		game: row.gameSystem,
		condition: row.condition,
		language: row.language,
		marketPrice: row.marketPrice,
		fxRate,
		attributes,
		onHand: row.onHand,
		quantity,
	}).price;
}

export interface RepriceWrite {
	row: SkuPriceRow;
	sellPrice?: Money | null;
	buyPrice?: Money | null;
}

/**
 * The guarded update per row, for the sides asked for that the rules
 * still own; nothing for a row pinned on every side asked. The watermark
 * moves only when the Sell side was evaluated.
 */
export function repriceStatement(db: Db, { row, sellPrice, buyPrice }: RepriceWrite, now: number) {
	const sets = [
		...(sellPrice !== undefined && row.sellPriceSource === 'rule' ? [sql`sell_price = ${sellPrice}`] : []),
		...(buyPrice !== undefined && row.buyPriceSource === 'rule' ? [sql`buy_price = ${buyPrice}`] : []),
		...(sellPrice !== undefined ? [sql`priced_at = ${now}`] : []),
	];
	if (sets.length === 0) {
		return undefined;
	}
	return prepared(db, sql`
		UPDATE sku SET ${sql.join(sets, sql`, `)}
		WHERE id = ${row.id} AND on_hand = ${row.onHand} AND sell_price_source = ${row.sellPriceSource} AND buy_price_source = ${row.buyPriceSource}
	`);
}

/** Evaluates the sides asked for on every row and writes them in one `batch()`; returns how many rows were written. */
export async function repriceRows(db: Db, ctx: PricingContext, rows: readonly SkuPriceRow[], { sides, now }: { sides: readonly Side[]; now: number }): Promise<number> {
	if (rows.length === 0) {
		return 0;
	}
	const attributes = await attributesFor(db, rows);
	const statements = rows.flatMap((row) => {
		const attrs = attributes.get(row.printingId) ?? {};
		const write: RepriceWrite = { row };
		if (sides.includes('sell')) {
			write.sellPrice = priceSide(ctx, row, attrs, 'sell');
		}
		if (sides.includes('buy')) {
			write.buyPrice = priceSide(ctx, row, attrs, 'buy');
		}
		const statement = repriceStatement(db, write, now);
		return statement === undefined ? [] : [statement];
	});
	if (statements.length === 0) {
		return 0;
	}
	const results = await db.$client.batch(statements);
	return results.filter(result => result.meta.changes === 1).length;
}

/**
 * The inline recompute after a ledger append (spec §6: every ledger
 * append for a SKU recomputes that SKU's Buy Price, one row, in the
 * request). A row the entry created has no price yet and takes both
 * sides: that is when a never-held card gets a stored price.
 */
export async function repriceAfterLedger(db: Db, ctx: PricingContext, skuIds: readonly string[], now = Date.now()): Promise<void> {
	const rows = (await Promise.all(slices(skuIds).map(ids =>
		db.select({ ...SKU_PRICE_COLUMNS, pricedAt: sku.pricedAt }).from(sku).innerJoin(printing, eq(printing.id, sku.printingId)).where(inArray(sku.id, ids)),
	))).flat();
	const fresh = rows.filter(row => row.pricedAt === null);
	const held = rows.filter(row => row.pricedAt !== null);
	await Promise.all([
		repriceRows(db, ctx, fresh, { sides: ['sell', 'buy'], now }),
		repriceRows(db, ctx, held, { sides: ['buy'], now }),
	]);
}
