import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Every db test starts from the committed migrations applied to a fresh
// local D1, the same files `pnpm db:migrate` hands to wrangler.
beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
