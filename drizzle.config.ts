import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated here and applied by wrangler
 * (`pnpm db:generate` → `pnpm db:migrate`), never pushed by drizzle-kit.
 */
export default defineConfig({
	dialect: 'sqlite',
	schema: './server/db/schema/index.ts',
	out: './server/db/migrations',
	casing: 'snake_case',
});
