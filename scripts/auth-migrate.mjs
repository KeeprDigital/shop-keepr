/**
 * Creates or updates Better Auth's tables in D1 (spec §7.1, ADR 0015).
 * Programmatic, because the Better Auth CLI cannot reach D1; idempotent,
 * because the plan holds only what is missing.
 *
 *   pnpm auth:migrate            apply to the local D1 under .wrangler/state (part of `pnpm db:migrate`)
 *   pnpm auth:migrate --print    print the full SQL, with IF NOT EXISTS, for a remote database:
 *                                pnpm auth:migrate --print > auth.sql && wrangler d1 execute shop-keepr --remote --file auth.sql
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { jiti, withLocalBindings } from './local-d1.mjs';

const { values } = parseArgs({ options: { print: { type: 'boolean', default: false } } });

const { createAuth, planAuthMigrations } = await jiti.import('../server/auth/auth.ts');

// `--print` plans against an empty in-memory D1 so the SQL is the whole
// schema, whatever the local database already holds.
await withLocalBindings(async (env) => {
	const auth = createAuth({ db: env.DB, secret: 'unused-while-migrating' });
	const plan = await planAuthMigrations(auth);
	if (values.print) {
		const sql = await plan.compileMigrations();
		process.stdout.write(sql.replace(/create table /gi, 'create table if not exists ').replace(/create (unique )?index /gi, 'create $1index if not exists '));
		return;
	}
	await plan.runMigrations();
	const created = plan.toBeCreated.map(table => table.table);
	console.log(created.length ? `auth tables created: ${created.join(', ')}` : 'auth tables up to date');
}, { persist: !values.print });
