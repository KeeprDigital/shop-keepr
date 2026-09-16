/**
 * The one evaluator (ADR 0004; spec §6, _The pipeline_): folds the side's
 * ordered step list over a Printing's Market Price. Every caller (the
 * sweep, the inline recompute, the counter, the kiosk, the "try a price"
 * dock) gets its number from here, so a price is the same wherever asked.
 * Pure: settings and a query in, integer minor units and a trace out.
 *
 * Invariants the fold enforces rather than configures: `fx` runs first,
 * whatever the step list says; the Value Band keys on the converted
 * Market Price, never the running total; `stock` and `quantity` apply on
 * the Buy side only. Round-before-floor is configurable and is the trap.
 */
import type { Condition } from '../domain/condition';
import type { Language } from '../domain/language';
import type { Money } from '../domain/money';
import type { AttributeRow, BuySettings, PricingSettings, Rounding, SellSettings, Side, StepId } from './settings';
import { money } from '../domain/money';
import { attributeRows, BUY_ONLY_STEPS, resolvedSide } from './settings';

export interface PriceQuery {
	side: Side;
	game: string;
	condition: Condition;
	language: Language;
	/** Integer minor units of the Catalogue's currency. */
	marketPrice: number;
	/** Catalogue currency → Store currency, the stepped rate in force (ADR 0003); 1 when they are the same. */
	fxRate: number;
	/** The Printing's Pricing Attribute values, by attribute key; null or absent when it has none. */
	attributes: Readonly<Record<string, string | null>>;
	/** Copies the store holds before this transaction; Buy only. */
	onHand: number;
	/** Copies on this line; 1 for the stored price; Buy only. */
	quantity: number;
}

export interface TraceStep {
	step: StepId;
	before: number;
	after: number;
	/** What the step applied, in words, for the "try a price" dock. */
	note: string;
}

export interface PriceResult {
	price: Money;
	/** The Market Price in Store currency: the output of `fx`, what the Value Band keys on. */
	converted: Money;
	trace: TraceStep[];
}

/** What a step sees: the running total, the converted Market Price, the query, the resolved rules and the rows that match. */
interface Fold {
	p: number;
	converted: number;
	q: PriceQuery;
	rules: SellSettings | BuySettings;
	rows: AttributeRow[];
}

interface Applied {
	p: number;
	note: string;
}

/** `p = round(p × k) + f`, integer minor units after every step. */
function affine(p: number, k: number, f: number): number {
	return Math.round(p * k) + f;
}

/** The highest band whose `from` is at or under `key`, else the first; bands ascend by `from`. */
function band<B extends { from: number }>(bands: readonly B[], key: number): B {
	const sorted = [...bands].sort((a, b) => a.from - b.from);
	return [...sorted].reverse().find(b => key >= b.from) ?? sorted[0]!;
}

function round(p: number, { inc, dir }: Rounding): number {
	const rounded = dir === 'up' ? Math.ceil : dir === 'down' ? Math.floor : Math.round;
	return rounded(p / inc) * inc;
}

/** A signed flat amount in words: ` + 100`, ` − 50`, or nothing for zero. */
const flatNote = (f: number) => (f ? (f < 0 ? ` − ${-f}` : ` + ${f}`) : '');

const kf = (k: number, f: number) => `× ${k}${flatNote(f)}`;

/** Buy-side settings, on a fold the step list has already established is a Buy. */
const buyRules = (fold: Fold) => fold.rules as BuySettings;

const STEPS: Record<Exclude<StepId, 'fx'>, (fold: Fold) => Applied> = {
	condition({ p, q, rules }) {
		const c = rules.condition[q.condition];
		return { p: affine(p, c.k, c.f), note: `${q.condition} ${kf(c.k, c.f)}` };
	},
	language({ p, q, rules }) {
		const c = rules.language[q.language] ?? { k: 1, f: 0 };
		return { p: affine(p, c.k, c.f), note: `${q.language} ${kf(c.k, c.f)}` };
	},
	percentage({ p, converted, rules }) {
		const b = band(rules.valueBands, converted);
		return { p: affine(p, b.pct / 100, b.f), note: `band ${b.from}+ → ${b.pct}%${flatNote(b.f)}` };
	},
	stock(fold) {
		const b = band(buyRules(fold).stockBands, fold.q.onHand);
		return { p: affine(fold.p, b.k, b.f), note: `${fold.q.onHand} on hand → band ${b.from}+ ${kf(b.k, b.f)}` };
	},
	quantity(fold) {
		const b = band(buyRules(fold).qtyBands, fold.q.quantity);
		return { p: affine(fold.p, b.k, b.f), note: `buying ${fold.q.quantity} → band ${b.from}+ ${kf(b.k, b.f)}` };
	},
	attributes({ p, q, rows }) {
		const parts: string[] = [];
		let next = p;
		for (const row of rows) {
			const { k, f } = row[q.side];
			if (k === 1 && f === 0) {
				continue;
			}
			next = affine(next, k, f);
			parts.push(`${row.value} ${kf(k, f)}`);
		}
		return { p: next, note: parts.length > 0 ? parts.join(', ') : 'no matching row' };
	},
	round({ p, rules }) {
		return { p: round(p, rules.rounding), note: `${rules.rounding.inc}, ${rules.rounding.dir}` };
	},
	floor({ p, q, rules, rows }) {
		const floors = rows.map(row => row[q.side].floor).filter((f): f is number => f !== null);
		const floor = Math.max(rules.floor, ...floors);
		const raisedBy = floors.length > 0 && floor > rules.floor ? rows.find(row => row[q.side].floor === floor)!.value : q.side === 'buy' ? 'Bulk Price' : 'Floor';
		return { p: Math.max(p, floor), note: p < floor ? `raised to ${raisedBy} ${floor}` : `above ${raisedBy} ${floor}` };
	},
};

export function evaluatePrice(settings: PricingSettings, q: PriceQuery): PriceResult {
	const rules = resolvedSide(settings, q.game, q.side);
	const rows = attributeRows(settings, q.game).filter(row => q.attributes[row.attr] === row.value);
	const converted = Math.round(q.marketPrice * q.fxRate);
	const fold: Fold = { p: converted, converted, q, rules, rows };
	const trace: TraceStep[] = [{ step: 'fx', before: q.marketPrice, after: converted, note: `${q.marketPrice} × ${q.fxRate}` }];
	for (const step of rules.steps) {
		if (step === 'fx' || (q.side !== 'buy' && BUY_ONLY_STEPS.includes(step))) {
			continue;
		}
		const before = fold.p;
		const { p, note } = STEPS[step](fold);
		fold.p = p;
		trace.push({ step, before, after: p, note });
	}
	return { price: money(fold.p), converted: money(converted), trace };
}
