/**
 * The Pricing Attribute values of Printings, read for the evaluator (spec
 * §6, _Inputs_; ADR 0004: pricing depends on Catalogue attributes being
 * queryable in the Mirror). Each Game System module's registry names the
 * attribute keys Pricing Rules may key on and the column on its search
 * table that holds each; this is the one read of a per-game table outside
 * search's own queries, kept here so search stays the only module that
 * knows the tables (ADR 0008).
 */
import type { D1Client } from '../db/client';
import { literal, packRows } from '../db/sql';
import { gameSystem } from './games';

export type PricingAttributes = Readonly<Record<string, string | null>>;

/** The values of every registered Pricing Attribute, per Printing, for Printings grouped by Game System; a game with no module yields none. */
export async function readPricingAttributes(db: D1Client, byGame: ReadonlyMap<string, readonly string[]>): Promise<Map<string, PricingAttributes>> {
	const found = new Map<string, PricingAttributes>();
	const selects: { attributes: string[]; sql: string }[] = [];
	for (const [game, ids] of byGame) {
		const module = gameSystem(game);
		if (!module || ids.length === 0) {
			continue;
		}
		const entries = Object.entries(module.pricingAttributes);
		const columns = entries.map(([attribute, column]) => `${column} AS ${literal(attribute)}`).join(', ');
		for (const statement of packRows(`SELECT id, ${columns} FROM ${module.table} WHERE id IN (`, ids.map(literal), ')')) {
			selects.push({ attributes: entries.map(([attribute]) => attribute), sql: statement });
		}
	}
	if (selects.length === 0) {
		return found;
	}
	const results = await db.batch<Record<string, string | null>>(selects.map(select => db.prepare(select.sql)));
	results.forEach((result, index) => {
		for (const row of result.results) {
			found.set(row.id!, Object.fromEntries(selects[index]!.attributes.map(attribute => [attribute, row[attribute] ?? null])));
		}
	});
	return found;
}
