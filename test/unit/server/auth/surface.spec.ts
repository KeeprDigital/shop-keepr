import { describe, expect, it } from 'vitest';
import { resolveSurface } from '../../../../server/auth/surface';

describe('resolveSurface', () => {
	it('places /api/staff/** on the staff surface', () => {
		expect(resolveSurface('/api/staff/health')).toBe('staff');
		expect(resolveSurface('/api/staff/inventory/skus?game=magic')).toBe('staff');
	});

	it('places /api/kiosk/** on the kiosk surface', () => {
		expect(resolveSurface('/api/kiosk/baskets')).toBe('kiosk');
	});

	it('leaves the Better Auth handler open', () => {
		expect(resolveSurface('/api/auth/sign-in/email')).toBe('open');
		expect(resolveSurface('/api/auth/get-session')).toBe('open');
	});

	it('leaves Nuxt Icon\'s public icon data open', () => {
		expect(resolveSurface('/api/_nuxt_icon/lucide.json?icons=search')).toBe('open');
	});

	it('denies any other API path by default', () => {
		expect(resolveSurface('/api/health')).toBe('none');
		expect(resolveSurface('/api/staffing')).toBe('none');
		expect(resolveSurface('/api/authentic')).toBe('none');
		expect(resolveSurface('/api')).toBe('none');
	});

	it('does not govern pages and assets', () => {
		expect(resolveSurface('/')).toBe('page');
		expect(resolveSurface('/login')).toBe('page');
		expect(resolveSurface('/_nuxt/entry.js')).toBe('page');
		expect(resolveSurface('/apiary')).toBe('page');
	});
});
