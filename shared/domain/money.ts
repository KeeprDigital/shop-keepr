/**
 * Money: an integer count of minor units (pence, cents) in the Store's one
 * trading currency, formatted at the edge only. The brand exists so the
 * pricing pipeline, the one place the app does arithmetic, cannot mix a
 * pence value with a count or a multiplier (spec §3, #2, #9).
 */
declare const moneyBrand: unique symbol;

export type Money = number & { readonly [moneyBrand]: true };

export function isMoney(value: unknown): value is Money {
	return typeof value === 'number' && Number.isSafeInteger(value);
}

export function money(minorUnits: number): Money {
	if (!isMoney(minorUnits)) {
		throw new RangeError(`Money must be a safe integer of minor units, got ${minorUnits}`);
	}
	return minorUnits;
}
