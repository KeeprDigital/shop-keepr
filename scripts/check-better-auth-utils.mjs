/**
 * Asserts the `@better-auth/utils` that `better-auth` resolves is at least
 * 0.4.1 (spec §7.1, _Versions_; ADR 0015). Below it the package has no
 * `workerd` export condition, so Workers silently falls to pure-JS scrypt
 * at ~5 s of CPU per sign-in: no error, no failing test, just a login that
 * times out under load. A lockfile can drift there; CI runs this on every
 * push.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

const FLOOR = '0.4.1';

/** The package.json of the package that owns `entry`, walking up from it. */
function packageJsonOf(entry, name) {
	let dir = dirname(entry);
	while (dir !== dirname(dir)) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			if (pkg.name === name) {
				return pkg;
			}
		}
		catch {}
		dir = dirname(dir);
	}
	throw new Error(`no package.json for ${name} above ${entry}`);
}

function compare(a, b) {
	const [x, y] = [a, b].map(v => v.split('.').map(Number));
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) {
			return x[i] - y[i];
		}
	}
	return 0;
}

const require = createRequire(import.meta.url);
const requireAsBetterAuth = createRequire(require.resolve('better-auth'));
const { version } = packageJsonOf(requireAsBetterAuth.resolve('@better-auth/utils'), '@better-auth/utils');

if (compare(version, FLOOR) < 0) {
	console.error(`@better-auth/utils ${version} resolved for better-auth; the floor is ${FLOOR} (workerd scrypt, spec §7.1)`);
	process.exit(1);
}
console.log(`@better-auth/utils ${version} resolved for better-auth (floor ${FLOOR})`);
