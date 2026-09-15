/**
 * Money is integer minor units until the edge (spec §6): this is the
 * edge. One formatter per currency, cached, since the table formats
 * hundreds of cells per render.
 */
const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
	let formatter = formatters.get(currency);
	if (!formatter) {
		formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });
		formatters.set(currency, formatter);
	}
	return formatter;
}

/** `1234` in GBP → `£12.34`; null → a dash, the table's "nothing to say". */
export function formatMoney(minorUnits: number | null | undefined, currency: string): string {
	if (minorUnits === null || minorUnits === undefined) {
		return '–';
	}
	const formatter = formatterFor(currency);
	const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(minorUnits / 10 ** digits);
}
