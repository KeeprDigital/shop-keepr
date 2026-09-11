import { describe, expect, it } from 'vitest';
import { isLanguage, LANGUAGES, normaliseLanguage } from '../../../shared/domain/language';

describe('language', () => {
	it('is the controlled BCP 47 list', () => {
		expect(LANGUAGES).toEqual(['en', 'ja', 'ko', 'fr', 'de', 'it', 'es', 'es-ES', 'es-419', 'pt-BR', 'zh-Hans', 'zh-Hant', 'x-phyrex']);
	});

	it('recognises only tags on the list, exactly as written', () => {
		expect(isLanguage('zh-Hant')).toBe(true);
		expect(isLanguage('zh-hant')).toBe(false);
		expect(isLanguage('english')).toBe(false);
	});

	describe('normaliseLanguage, the one write-boundary rule', () => {
		it('maps absent, null and blank to the store default', () => {
			expect(normaliseLanguage(undefined, 'en')).toBe('en');
			expect(normaliseLanguage(null, 'en')).toBe('en');
			expect(normaliseLanguage('   ', 'ja')).toBe('ja');
		});

		it('canonicalises case and whitespace to the list form', () => {
			expect(normaliseLanguage(' JA ', 'en')).toBe('ja');
			expect(normaliseLanguage('ZH-HANT', 'en')).toBe('zh-Hant');
			expect(normaliseLanguage('X-Phyrex', 'en')).toBe('x-phyrex');
		});

		it('refuses a tag off the list', () => {
			expect(() => normaliseLanguage('klingon', 'en')).toThrow(/klingon/);
		});
	});
});
