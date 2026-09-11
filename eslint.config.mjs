// @ts-check
import antfu from '@antfu/eslint-config';
import withNuxt from './.nuxt/eslint.config.mjs';

export default withNuxt(
	antfu({
		// Throwaway spikes (issues #4, #13, #18, #19); not app code.
		ignores: [
			'spike/**',
			// drizzle-kit's snapshot and journal files.
			'server/db/migrations/meta/**',
			// `wrangler types` output.
			'worker-configuration.d.ts',
		],
		antislop: true,
		typescript: true,
		vue: true,
		formatters: {
			markdown: 'prettier',
			svg: 'prettier',
			css: 'prettier',
		},
		stylistic: {
			semi: true,
			indent: 'tab',
		},
	}),
	{
		// The glossary is written as `**Term** (em dash) definition`, so the
		// antislop em-dash rule fights its own house style. This is why
		// `pnpm lint` failed on main.
		files: ['**/*.md', '**/*.md/**'],
		rules: {
			'slop/no-em-dash': 'off',
		},
	},
);
