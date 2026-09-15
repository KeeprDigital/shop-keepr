/**
 * The Pricing Rules' read and write paths (spec §6, _Store settings_; ADR
 * 0004). Reading assembles the `PricingSettings` the evaluator folds from
 * one row per setting per scope; writing lands one setting, then asks for
 * the sweep the change needs (spec §6, _When prices are recomputed_): the
 * games that inherit a Store default, the one game of a game-scope edit,
 * none for Tender.
 */
import type { PricingSettingsView, PricingSettingWrite, PricingSettingWriteOutcome } from '../../shared/contracts/staff/pricing-settings';
import type { BuySettings, GameScope, PricingSettings, SellSettings, SettingChange } from '../../shared/pricing/settings';
import type { Db } from '../db/client';
import type { RepriceQueue } from './sweep';
import { and, eq, sql } from 'drizzle-orm';
import { zPricingSettingWrite } from '../../shared/contracts/staff/pricing-settings';
import { affectedGames, BUY_SETTING_KEYS, ROWS_KEY, SELL_SETTING_KEYS, STORE_SCOPE } from '../../shared/pricing/settings';
import { pricingSetting, store } from '../db/schema';
import { GAME_SYSTEMS } from '../search/games';
import { apiError } from '../utils/api-error';
import { STORE_ID } from '../utils/store';
import { estimateSweep, requestSweep } from './sweep';

/** The Game Systems the store trades: the scopes beside the Store defaults. */
export const TRADED_GAMES: readonly string[] = GAME_SYSTEMS.map(module => module.game);

/** Every setting, every scope, as the evaluator folds them; refuses to answer without the seeded Store rows. */
export async function readPricingSettings(db: Db): Promise<PricingSettings> {
	const rows = await db.select({ scope: pricingSetting.scope, side: pricingSetting.side, key: pricingSetting.key, value: pricingSetting.value })
		.from(pricingSetting)
		.where(eq(pricingSetting.storeId, STORE_ID));
	const sell: Partial<SellSettings> = {};
	const buy: Partial<BuySettings> = {};
	const games: Record<string, GameScope> = {};
	for (const row of rows) {
		const value: unknown = JSON.parse(row.value);
		if (row.scope === STORE_SCOPE) {
			(row.side === 'sell' ? sell as Record<string, unknown> : buy as Record<string, unknown>)[row.key] = value;
			continue;
		}
		const game = (games[row.scope] ??= { sell: {}, buy: {}, rows: [] });
		if (row.side === ROWS_KEY) {
			game.rows = value as GameScope['rows'];
		}
		else {
			(game[row.side as 'sell' | 'buy'] as Record<string, unknown>)[row.key] = value;
		}
	}
	const missing = [
		...SELL_SETTING_KEYS.filter(key => sell[key] === undefined).map(key => `sell.${key}`),
		...BUY_SETTING_KEYS.filter(key => buy[key] === undefined).map(key => `buy.${key}`),
	];
	if (missing.length > 0) {
		throw apiError('INTERNAL', { message: `Store pricing settings missing (${missing.join(', ')}); run the migrations` });
	}
	return { store: { sell: sell as SellSettings, buy: buy as BuySettings }, games };
}

export async function readPricingSettingsView(db: Db): Promise<PricingSettingsView> {
	const [settings, row] = await Promise.all([
		readPricingSettings(db),
		db.query.store.findFirst({ columns: { currency: true }, where: eq(store.id, STORE_ID) }),
	]);
	if (!row) {
		throw apiError('INTERNAL', { message: 'Store row missing; run the migrations' });
	}
	return { settings, games: [...TRADED_GAMES], currency: row.currency };
}

/**
 * Lands one setting and asks for the sweep it needs. The value is checked
 * against the setting's own shape first, so a bad number never reaches
 * the evaluator. A Game System holds a row only where it overrides, so a
 * revert deletes the row and a scope with nothing left simply vanishes.
 */
export async function writePricingSetting(db: Db, input: PricingSettingWrite, { queue, now = Date.now() }: { queue: RepriceQueue; now?: number }): Promise<PricingSettingWriteOutcome> {
	const parsed = zPricingSettingWrite.safeParse(input);
	if (!parsed.success) {
		throw apiError('VALIDATION_FAILED', { details: { issues: parsed.error.issues } });
	}
	const write = parsed.data;
	if (write.scope !== STORE_SCOPE && !TRADED_GAMES.includes(write.scope)) {
		throw apiError('VALIDATION_FAILED', { message: `${write.scope} is not a Game System the store trades`, details: { issues: [] } });
	}
	const before = await readPricingSettings(db);
	const clearing = write.value === null || (write.ref.side === ROWS_KEY && (write.value as unknown[]).length === 0);
	const key = { storeId: STORE_ID, scope: write.scope, side: write.ref.side, key: write.ref.key };
	if (clearing) {
		await db.delete(pricingSetting).where(and(eq(pricingSetting.storeId, STORE_ID), eq(pricingSetting.scope, key.scope), eq(pricingSetting.side, key.side), eq(pricingSetting.key, key.key)));
	}
	else {
		const value = JSON.stringify(write.value);
		await db.insert(pricingSetting)
			.values({ ...key, value, updatedAt: now })
			.onConflictDoUpdate({ target: [pricingSetting.storeId, pricingSetting.scope, pricingSetting.side, pricingSetting.key], set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` } });
	}
	const change: SettingChange = { scope: write.scope, side: write.ref.side === ROWS_KEY ? 'sell' : write.ref.side, key: write.ref.key };
	// Inheritance is judged against the settings as they stood: a Store default just written reaches the games that did not override it.
	const games = affectedGames(before, change, TRADED_GAMES);
	const skus = games.length > 0 ? await estimateSweep(db, { games, watermark: false }) : 0;
	const sweep = games.length > 0 ? await requestSweep(db, queue, { reason: 'settings', games, watermark: false, now }) : null;
	const view = await readPricingSettingsView(db);
	return { ...view, sweep: { games, skus }, sweepId: sweep?.sweepId ?? null };
}
