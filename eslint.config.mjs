// @ts-check
import antfu from '@antfu/eslint-config';
import withNuxt from './.nuxt/eslint.config.mjs';

export default withNuxt(
	antfu({
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
