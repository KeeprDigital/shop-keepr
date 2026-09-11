/**
 * drizzle-kit cannot emit `STRICT` tables, and the spec requires them
 * (§4.1, Tables). Run after `drizzle-kit generate`: rewrites every
 * `CREATE TABLE … );` in the migrations folder to `… ) STRICT;`.
 * Idempotent; leaves virtual tables (FTS5) alone, which cannot be STRICT.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../server/db/migrations', import.meta.url).pathname;
const pattern = /^(CREATE TABLE [`"'\w ]+\([\s\S]*?\n)\);/gm;

for (const name of readdirSync(dir).filter(f => f.endsWith('.sql'))) {
	const path = join(dir, name);
	const before = readFileSync(path, 'utf8');
	const after = before.replace(pattern, '$1) STRICT;');
	if (after !== before) {
		writeFileSync(path, after);
		console.log(`STRICT: ${name}`);
	}
}
