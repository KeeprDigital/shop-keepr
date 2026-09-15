/**
 * The Pricing Rules as the Settings › Pricing page reads and writes them
 * (spec §6, _Store settings_; #63). One write is one setting in one scope;
 * the value is validated against the setting's own shape here, so nothing
 * can be stored that the evaluator cannot fold. A write with `value: null`
 * reverts a Game System to the Store default.
 */
import type { PricingSettings, Side } from '../../pricing/settings';
import * as z from 'zod';
import { CONDITIONS } from '../../domain/condition';
import { LANGUAGES } from '../../domain/language';
import { TENDERS } from '../../domain/ledger';
import { BUY_ONLY_STEPS, BUY_SETTING_KEYS, ROUNDING_DIRECTIONS, ROWS_KEY, SELL_SETTING_KEYS, SIDES, STEP_IDS, STORE_SCOPE } from '../../pricing/settings';

const zMinorUnits = z.number().int().safe();
const zMultiplier = z.number().finite().min(0);
const zAffine = z.object({ k: zMultiplier, f: zMinorUnits });

export const zValueBands = z.array(z.object({ from: zMinorUnits.min(0), pct: z.number().finite().min(0), f: zMinorUnits })).min(1);
export const zCountBands = z.array(z.object({ from: z.number().int().min(0), k: zMultiplier, f: zMinorUnits })).min(1);
export const zConditionSetting = z.object(Object.fromEntries(CONDITIONS.map(code => [code, zAffine])) as Record<(typeof CONDITIONS)[number], typeof zAffine>);
export const zLanguageSetting = z.partialRecord(z.enum(LANGUAGES), zAffine);
export const zFloor = zMinorUnits.min(0);
export const zRounding = z.object({ inc: z.number().int().min(1), dir: z.enum(ROUNDING_DIRECTIONS) });
export const zTenderSetting = z.object({ def: z.enum(TENDERS), mod: z.number().int() });
export const zAttributeRows = z.array(z.object({
	attr: z.string().trim().min(1),
	value: z.string().trim().min(1),
	sell: zAffine.extend({ floor: zFloor.nullable() }),
	buy: zAffine.extend({ floor: zFloor.nullable() }),
}));

/** The step list: every id once at most, `fx` first, and the Buy-only steps nowhere on the Sell side (ADR 0004's enforced invariants). */
export function zSteps(side: Side) {
	return z.array(z.enum(STEP_IDS)).min(1).refine(steps => steps[0] === 'fx', { message: 'fx runs first' }).refine(steps => new Set(steps).size === steps.length, { message: 'a step appears once' }).refine(steps => side === 'buy' || !steps.some(step => BUY_ONLY_STEPS.includes(step)), { message: 'stock and quantity are Buy-only steps' });
}

/** Where a write lands: a setting on one side, or a Game System's attribute rows, which belong to both. */
export const zSettingRef = z.discriminatedUnion('side', [
	z.object({ side: z.literal('sell'), key: z.enum(SELL_SETTING_KEYS) }),
	z.object({ side: z.literal('buy'), key: z.enum(BUY_SETTING_KEYS) }),
	z.object({ side: z.literal(ROWS_KEY), key: z.literal(ROWS_KEY) }),
]);

export type SettingRef = z.output<typeof zSettingRef>;

/** The Zod schema a setting's value must satisfy. */
export function settingValueSchema(ref: SettingRef): z.ZodType {
	if (ref.side === ROWS_KEY) {
		return zAttributeRows;
	}
	switch (ref.key) {
		case 'valueBands': return zValueBands;
		case 'condition': return zConditionSetting;
		case 'language': return zLanguageSetting;
		case 'floor': return zFloor;
		case 'rounding': return zRounding;
		case 'steps': return zSteps(ref.side);
		case 'stockBands':
		case 'qtyBands': return zCountBands;
		case 'tender': return zTenderSetting;
	}
}

export const zPricingSettingWrite = z.object({
	/** `store`, or a Game System code. */
	scope: z.string().trim().min(1),
	ref: zSettingRef,
	/** Null reverts a Game System's override; the Store defaults always hold a value. */
	value: z.unknown().nullable(),
}).superRefine((write, ctx) => {
	const storeScope = write.scope === STORE_SCOPE;
	if (write.ref.side === ROWS_KEY && storeScope) {
		ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Attribute rows belong to a Game System; there is no Store default' });
	}
	if (write.ref.side === 'buy' && write.ref.key === 'tender' && !storeScope) {
		ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Tender is a Store setting; no Game System overrides it' });
	}
	if (write.value === null && (storeScope || write.ref.side === ROWS_KEY)) {
		ctx.addIssue({ code: 'custom', path: ['value'], message: 'A Store default or an attribute-row list is set, never reverted' });
	}
	if (write.value !== null) {
		const parsed = settingValueSchema(write.ref).safeParse(write.value);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				ctx.addIssue({ ...issue, path: ['value', ...issue.path] });
			}
		}
	}
});

export type PricingSettingWrite = z.output<typeof zPricingSettingWrite>;

export interface PricingSettingsView {
	settings: PricingSettings;
	/** The Game Systems the store trades, the scopes beside the Store defaults. */
	games: string[];
	/** ISO 4217, for formatting the minor units in every setting. */
	currency: string;
}

/** What one write set in motion. */
export interface SweepEstimate {
	games: string[];
	/** SKUs the sweep will visit: on hand or pinned, in those games. */
	skus: number;
}

export interface PricingSettingWriteOutcome extends PricingSettingsView {
	sweep: SweepEstimate;
	/** The sweep's id, or null when the change reprices nothing (Tender, or no game inherits it). */
	sweepId: string | null;
}

export { SIDES };
