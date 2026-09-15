/**
 * The production Worker entry (`nuxt.config.ts`, `$production.nitro.entry`):
 * Nitro's own cloudflare-module handler plus the classes the bindings in
 * `wrangler.jsonc` name. Nitro cannot add named exports to its entry, and a
 * Workflow binding needs its class exported from the Worker.
 */
export { CatalogueSyncWorkflow } from './catalogue/sync/workflow';
export { default } from 'nitropack/presets/cloudflare/runtime/cloudflare-module';
