// @ts-check
import antfu from '@antfu/eslint-config';
import withNuxt from './.nuxt/eslint.config.mjs';

export default withNuxt(
	antfu({
		// Throwaway spike for issue #4; not app code.
		ignores: ['spike/**'],
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
);
