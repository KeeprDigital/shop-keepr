/**
 * The Pricing Rules as data (spec §6, _Store settings_; ADR 0004): every
 * setting the evaluator folds, its shape, its scope, and the seed every
 * Store starts with. Ported from the DOM-free module on
 * `prototype/pricing-settings`. Money here is integer minor units of the
 * Store's currency; multipliers are plain numbers.
 *
 * Resolution is **per setting**: a Game System's value if it sets one,
 * else the Store default. Attribute rows belong to a Game System only,
 * and Tender to the Store only. There is no pricing formula anywhere
 * else: change a number here and every price changes.
 */
import type { Condition } from '../domain/condition';
import type { Language } from '../domain/language';
import type { Tender } from '../domain/ledger';

export const SIDES = ['sell', 'buy'] as const;

export type Side = (typeof SIDES)[number];

/** The scope that holds the Store defaults; any other scope is a Game System code. */
export const STORE_SCOPE = 'store';

/** The closed step set (spec §6, _Steps_). `fx` always runs first; `stock` and `quantity` are Buy-only. */
export const STEP_IDS = ['fx', 'condition', 'language', 'percentage', 'stock', 'quantity', 'attributes', 'round', 'floor'] as const;

export type StepId = (typeof STEP_IDS)[number];

export const BUY_ONLY_STEPS: readonly StepId[] = ['stock', 'quantity'];

/** The default calculation order per side; configurable, hidden from the MVP page. */
export const DEFAULT_STEPS: Record<Side, StepId[]> = {
	sell: ['fx', 'condition', 'language', 'percentage', 'attributes', 'round', 'floor'],
	buy: ['fx', 'condition', 'language', 'percentage', 'stock', 'quantity', 'attributes', 'round', 'floor'],
};

/** A multiplier and a signed flat amount, applied together: `p = round(p × k) + f`. */
export interface Affine {
	k: number;
	/** Signed minor units. */
	f: number;
}

/** Percentage of the converted Market Price, by the band it falls in; `from` in minor units. */
export interface ValueBand {
	from: number;
	pct: number;
	f: number;
}

/** A Stock or Quantity Band: `from` is a copy count. */
export interface CountBand extends Affine {
	from: number;
}

export const ROUNDING_DIRECTIONS = ['up', 'down', 'nearest'] as const;

export type RoundingDirection = (typeof ROUNDING_DIRECTIONS)[number];

export interface Rounding {
	/** Minor units, at least 1. */
	inc: number;
	dir: RoundingDirection;
}

export interface AttributeRowSide extends Affine {
	/** Minor units, or null for no Floor on this side. */
	floor: number | null;
}

/** One Pricing Attribute value, both sides at once (spec §6: a row exists on both sides). */
export interface AttributeRow {
	attr: string;
	value: string;
	sell: AttributeRowSide;
	buy: AttributeRowSide;
}

/** Default Tender and Tender Modifier: a factor on a Buy's total, never a step (ADR 0010). */
export interface TenderSetting {
	def: Tender;
	/** Whole percent, unbounded. */
	mod: number;
}

/** What both sides configure. */
export interface SideSettings {
	valueBands: ValueBand[];
	condition: Record<Condition, Affine>;
	/** A Language with no entry is `×1 +0`. */
	language: Partial<Record<Language, Affine>>;
	/** Sell: the Floor. Buy: the Bulk Price. Minor units. */
	floor: number;
	rounding: Rounding;
	steps: StepId[];
}

export type SellSettings = SideSettings;

export interface BuySettings extends SideSettings {
	stockBands: CountBand[];
	qtyBands: CountBand[];
	tender: TenderSetting;
}

export type SettingsOf<S extends Side> = S extends 'sell' ? SellSettings : BuySettings;

export const SELL_SETTING_KEYS = ['valueBands', 'condition', 'language', 'floor', 'rounding', 'steps'] as const satisfies readonly (keyof SellSettings)[];

export const BUY_SETTING_KEYS = ['valueBands', 'condition', 'language', 'stockBands', 'qtyBands', 'floor', 'rounding', 'tender', 'steps'] as const satisfies readonly (keyof BuySettings)[];

export type SellSettingKey = (typeof SELL_SETTING_KEYS)[number];

export type BuySettingKey = (typeof BUY_SETTING_KEYS)[number];

export type SettingKey = SellSettingKey | BuySettingKey;

/** The one setting a Game System alone holds. */
export const ROWS_KEY = 'rows';

/** The one setting the Store alone holds; a change to it never sweeps. */
export const STORE_ONLY_KEYS: readonly SettingKey[] = ['tender'];

export interface StoreScope {
	sell: SellSettings;
	buy: BuySettings;
}

/** A Game System's own values, each present only where it overrides the Store; plus its attribute rows. */
export interface GameScope {
	sell: Partial<SellSettings>;
	buy: Partial<Omit<BuySettings, 'tender'>>;
	rows: AttributeRow[];
}

export interface PricingSettings {
	store: StoreScope;
	games: Record<string, GameScope>;
}

export const EMPTY_GAME_SCOPE: GameScope = { sell: {}, buy: {}, rows: [] };

const affine = (k: number, f = 0): Affine => ({ k, f });

/**
 * What every Store starts with. Fixed by ticket: neutral Stock and Quantity
 * Bands, Default Tender `cash`, Tender Modifier 0 (#48, #43). The rest is
 * the prototype's demo, since no ticket fixed a number (spec §6, _Store
 * settings_: Open) and the evaluator needs one to fold.
 */
export const SEEDED_STORE_SETTINGS: StoreScope = {
	sell: {
		valueBands: [{ from: 0, pct: 100, f: 0 }, { from: 1000, pct: 105, f: 0 }, { from: 5000, pct: 110, f: 0 }],
		condition: { NM: affine(1), LP: affine(0.85), MP: affine(0.7), HP: affine(0.5), DMG: affine(0.3) },
		language: { en: affine(1), ja: affine(0.9), de: affine(0.8), fr: affine(0.8), it: affine(0.8) },
		floor: 25,
		rounding: { inc: 10, dir: 'up' },
		steps: [...DEFAULT_STEPS.sell],
	},
	buy: {
		valueBands: [{ from: 0, pct: 50, f: 0 }, { from: 500, pct: 60, f: 0 }, { from: 2000, pct: 65, f: 0 }],
		condition: { NM: affine(1), LP: affine(0.8), MP: affine(0.6), HP: affine(0.4), DMG: affine(0.2) },
		language: { en: affine(1), ja: affine(0.8), de: affine(0.7), fr: affine(0.7), it: affine(0.7) },
		stockBands: [{ from: 0, k: 1, f: 0 }],
		qtyBands: [{ from: 1, k: 1, f: 0 }],
		floor: 5,
		rounding: { inc: 5, dir: 'down' },
		tender: { def: 'cash', mod: 0 },
		steps: [...DEFAULT_STEPS.buy],
	},
};

export interface Resolved<T> {
	value: T;
	/** `store`, or the Game System that overrides. */
	from: string;
}

/** One setting, resolved down the chain: the Game System's own value if it sets one, else the Store default. */
export function resolveSetting<S extends Side, K extends keyof SettingsOf<S>>(settings: PricingSettings, game: string, side: S, key: K): Resolved<SettingsOf<S>[K]> {
	const scope = settings.games[game];
	const own = scope?.[side] as Partial<SettingsOf<S>> | undefined;
	if (own && own[key] !== undefined) {
		return { value: own[key] as SettingsOf<S>[K], from: game };
	}
	return { value: (settings.store[side] as SettingsOf<S>)[key], from: STORE_SCOPE };
}

/** Every setting of `side` resolved for `game`, as the evaluator folds them. */
export function resolvedSide<S extends Side>(settings: PricingSettings, game: string, side: S): SettingsOf<S> {
	const store = settings.store[side] as SettingsOf<S>;
	const own = (settings.games[game]?.[side] ?? {}) as Partial<SettingsOf<S>>;
	return { ...store, ...own };
}

/** The attribute rows of `game`, none when it has none. */
export function attributeRows(settings: PricingSettings, game: string): AttributeRow[] {
	return settings.games[game]?.rows ?? [];
}

/** Where a change lands: the Store defaults, or one Game System. */
export interface SettingChange {
	scope: string;
	side: Side;
	key: SettingKey | typeof ROWS_KEY;
}

/**
 * The Game Systems whose prices a change touches, from `games`, the ones
 * the store trades: a game-scope change reaches that game; a Store-default
 * change reaches every game that inherits the setting; Tender reaches
 * none, since it acts on a total, not a price (spec §6, _Sweep estimate_).
 */
export function affectedGames(settings: PricingSettings, change: SettingChange, games: readonly string[]): string[] {
	if (STORE_ONLY_KEYS.includes(change.key as SettingKey)) {
		return [];
	}
	if (change.scope !== STORE_SCOPE) {
		return games.includes(change.scope) ? [change.scope] : [];
	}
	return games.filter((game) => {
		const own = settings.games[game]?.[change.side] as Partial<SideSettings> | undefined;
		return own?.[change.key as keyof SideSettings] === undefined;
	});
}
