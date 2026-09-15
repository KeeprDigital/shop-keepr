/**
 * Language: the language a SKU is printed in, as a BCP 47 tag from a
 * controlled list. Language belongs to the SKU, not the Printing, and is
 * `NOT NULL` in the SKU key (ADR 0002).
 */
import { isOneOf } from './one-of';

export const LANGUAGES = [
	'en',
	'ja',
	'ko',
	'fr',
	'de',
	'it',
	'es',
	'es-ES',
	'es-419',
	'pt-BR',
	'zh-Hans',
	'zh-Hant',
	'x-phyrex',
] as const;

export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
	return isOneOf(LANGUAGES, value);
}

const LANGUAGE_BY_LOWERCASED_TAG = new Map<string, Language>(LANGUAGES.map(tag => [tag.toLowerCase(), tag]));

/**
 * The one shared normalisation rule at the write boundary (ADR 0002): blank,
 * absent and the store default all resolve to a single canonical tag, so
 * one pile of stock can never split into several SKUs by spelling. Every
 * write path that sets Language goes through here.
 */
export function normaliseLanguage(input: string | null | undefined, storeDefault: Language): Language {
	const trimmed = input?.trim();
	if (!trimmed) {
		return storeDefault;
	}
	const tag = LANGUAGE_BY_LOWERCASED_TAG.get(trimmed.toLowerCase());
	if (!tag) {
		throw new RangeError(`Unknown Language tag: ${trimmed}`);
	}
	return tag;
}
