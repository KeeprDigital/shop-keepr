// Nitro's cloudflare-module runtime entry, re-exported by
// server/entry.cloudflare.ts. Nitro aliases `nitropack` for the build; this
// gives the typecheck the same module.
declare module 'nitropack/presets/cloudflare/runtime/cloudflare-module' {
	const handler: ExportedHandler<Env>;
	export default handler;
}
