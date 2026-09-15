/**
 * Creates or updates Better Auth's tables in D1 (spec §7.1, ADR 0015).
 * Programmatic, because the Better Auth CLI cannot reach D1; idempotent,
 * because `getMigrations` plans only what is missing.
 *
 *   pnpm auth:migrate            apply to the local D1 under .wrangler/state (part of `pnpm db:migrate`)
 *   pnpm auth:migrate --print    print the full SQL, with IF NOT EXISTS, for a remote database:
 *                                pnpm auth:migrate --print > auth.sql && wrangler d1 execute shop-keepr --remote --file auth.sql
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { getMigrations } from 'better-auth/db/migration';
import { createJiti } from 'jiti';
import { getPlatformProxy } from 'wrangler';

const { values } = parseArgs({ options: { print: { type: 'boolean', default: false } } });

const jiti = createJiti(import.meta.url);
const { createAuth } = await jiti.import('../server/auth/auth.ts');

// `--print` plans against an empty in-memory D1 so the SQL is the whole
// schema, whatever the local database already holds.
const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist: !values.print });
try {
	const auth = createAuth({ db: proxy.env.DB, secret: 'unused-while-migrating' });
	const migrations = await getMigrations(auth.options);
	if (values.print) {
		const sql = await migrations.compileMigrations();
		process.stdout.write(sql.replace(/create table /gi, 'create table if not exists ').replace(/create (unique )?index /gi, 'create $1index if not exists '));
	}
	else {
		await migrations.runMigrations();
		const created = migrations.toBeCreated.map(table => table.table);
		console.log(created.length ? `auth tables created: ${created.join(', ')}` : 'auth tables up to date');
	}
}
finally {
	await proxy.dispose();
}
