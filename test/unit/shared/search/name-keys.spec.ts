import { describe, expect, it } from 'vitest';
import { fold, foldNoSpace, foldTokens, metaphoneKey, NAME_KEYS_VERSION, tokenTrigrams } from '../../../../shared/search/name-keys';

describe('name folding (spec §4.3.1: the rule every search key and every query string goes through)', () => {
	it('strips accents, lowercases and collapses whitespace', () => {
		expect(fold('Pokégear 3.0')).toBe('pokegear 3 0');
		expect(fold('  Jace,   the Mind Sculptor ')).toBe('jace the mind sculptor');
		expect(fold('Lim-Dûl the Necromancer')).toBe('lim dul the necromancer');
	});

	it('deletes apostrophes of every shape, so a customer who types Farfetchd finds Farfetch\'d', () => {
		expect(fold('Farfetch\'d')).toBe('farfetchd');
		expect(fold('Farfetch’d')).toBe('farfetchd');
		expect(fold('Kai`Sa')).toBe('kaisa');
		expect(fold('‘Ach! Hans, Run!’')).toBe('ach hans run');
	});

	it('turns every other punctuation run into one space', () => {
		expect(fold('Ho-Oh')).toBe('ho oh');
		expect(fold('Invasion of Zendikar // Awakened Skyclave')).toBe('invasion of zendikar awakened skyclave');
		expect(fold('"Rumors of My Death . . ."')).toBe('rumors of my death');
	});

	it('drops symbols nobody can type, by NFKD', () => {
		expect(fold('Beedrill δ')).toBe('beedrill');
		expect(fold('Nidoran ♀')).toBe('nidoran');
		expect(fold('Pikachu ★')).toBe('pikachu');
	});

	it('keeps letters and digits from every script', () => {
		expect(fold('ピカチュウ')).toBe('ピカチュウ');
		expect(fold('ガブリアス')).toBe('ガブリアス');
		expect(fold('Ｐｉｋａｃｈｕ')).toBe('pikachu');
	});

	it('has a space-free twin for the second exact tier', () => {
		expect(foldNoSpace('Ho-Oh')).toBe('hooh');
		expect(foldNoSpace('Lightning Bolt')).toBe('lightningbolt');
	});

	it('tokenises on the folded form and yields nothing for an untypeable name', () => {
		expect(foldTokens('Jace, the Mind Sculptor')).toEqual(['jace', 'the', 'mind', 'sculptor']);
		expect(foldTokens('★')).toEqual([]);
	});

	it('is versioned, so a rule change is a re-seed', () => {
		expect(NAME_KEYS_VERSION).toBe(1);
	});
});

describe('double Metaphone key (spec §4.3.2: primary key per token on the folded form, joined by a space)', () => {
	it('gives a respelling and a romanisation variant the same key as the name', () => {
		expect(metaphoneKey('Lightning Bolt')).toBe('LTNNK PLT');
		expect(metaphoneKey('lightening bolt')).toBe('LTNNK PLT');
		expect(metaphoneKey('Kouzuki')).toBe(metaphoneKey('Kozuki'));
	});

	it('falls back to the token itself where the algorithm has nothing to say', () => {
		expect(metaphoneKey('Pokégear 3.0')).toBe('PKJR 3 0');
		expect(metaphoneKey('ピカチュウ')).toBe('ピカチュウ');
	});
});

describe('token trigrams (spec §4.3.4: padded two spaces each side, len + 2 per token)', () => {
	it('pads one token two spaces each side', () => {
		expect(tokenTrigrams('bolt')).toEqual(['  b', ' bo', 'bol', 'olt', 'lt ', 't  ']);
	});

	it('is empty for a token shorter than one character', () => {
		expect(tokenTrigrams('')).toEqual([]);
	});
});
