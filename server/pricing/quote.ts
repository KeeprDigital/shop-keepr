/**
 * A Printing priced on read (spec §6, _Stored SKU prices and recompute_):
 * the price of a SKU the store may never have held, through the same
 * evaluator, at on-hand 0, creating no row. Where a row exists it is
 * read as it stands: its on-hand feeds the Stock Band, and a pinned side
 * is final, the Quantity Band and all (spec §6, _Pinned Price_). A Buy
 * line asks with its quantity and gets one price for the line beside the
 * unit price at one (spec §6, _Buy-line evaluation_).
 */
import type { Condition } from '../../shared/domain/condition';
import type { Language } from '../../shared/domain/language';
import type { Money } from '../../shared/domain/money';
import type { PriceSource } from '../../shared/domain/reprice';
import type { Db } from '../db/client';
import type { PricingContext } from './context';
import type { PriceInput } from './reprice';
import { and, eq } from 'drizzle-orm';
import { printing, sku } from '../db/schema';
import { apiError } from '../utils/api-error';
import { STORE_ID } from '../utils/store';
import { loadPricingContext } from './context';
import { attributesFor, priceSide } from './reprice';

export interface QuoteRequest {
	printingId: string;
	condition: Condition;
	language: Language;
	/** Copies on the Buy line; 1 by default. */
	quantity?: number;
}

export interface Quote {
	/** The stored row's id, or null when the store has never held this SKU. */
	skuId: string | null;
	onHand: number;
	marketPrice: number | null;
	marketPriceCurrency: string | null;
	sellPrice: Money | null;
	sellPriceSource: PriceSource;
	/** At the quantity asked for. */
	buyPrice: Money | null;
	buyPriceSource: PriceSource;
	/** The unit price at quantity 1, what the stored column holds. */
	buyPriceAtOne: Money | null;
}

export async function quotePrinting(db: Db, { printingId, condition, language, quantity = 1 }: QuoteRequest, ctx?: PricingContext): Promise<Quote> {
	const found = await db.query.printing.findFirst({ columns: { gameSystem: true, marketPrice: true, marketPriceCurrency: true }, where: eq(printing.id, printingId) });
	if (!found) {
		throw apiError('NOT_FOUND', { message: 'No such Printing in the Mirror' });
	}
	const held = await db.query.sku.findFirst({
		columns: { id: true, onHand: true, sellPrice: true, sellPriceSource: true, buyPrice: true, buyPriceSource: true },
		where: and(eq(sku.storeId, STORE_ID), eq(sku.printingId, printingId), eq(sku.condition, condition), eq(sku.language, language)),
	});
	const context = ctx ?? await loadPricingContext(db);
	const row: PriceInput = {
		printingId,
		gameSystem: found.gameSystem,
		condition,
		language,
		onHand: held?.onHand ?? 0,
		marketPrice: found.marketPrice,
		marketPriceCurrency: found.marketPriceCurrency,
		sellPriceSource: held?.sellPriceSource ?? 'rule',
		buyPriceSource: held?.buyPriceSource ?? 'rule',
	};
	const attributes = (await attributesFor(db, [row])).get(printingId) ?? {};
	const sellPrice = row.sellPriceSource === 'pinned' ? held!.sellPrice : priceSide(context, row, attributes, 'sell');
	const pinnedBuy = row.buyPriceSource === 'pinned';
	return {
		skuId: held?.id ?? null,
		onHand: row.onHand,
		marketPrice: found.marketPrice,
		marketPriceCurrency: found.marketPriceCurrency,
		sellPrice,
		sellPriceSource: row.sellPriceSource,
		buyPrice: pinnedBuy ? held!.buyPrice : priceSide(context, row, attributes, 'buy', quantity),
		buyPriceSource: row.buyPriceSource,
		buyPriceAtOne: pinnedBuy ? held!.buyPrice : priceSide(context, row, attributes, 'buy', 1),
	};
}
