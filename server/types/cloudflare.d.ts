// The Cloudflare bindings Nitro attaches to every request under the
// Cloudflare preset, typed from the generated worker-configuration.d.ts at
// the repo root (`pnpm cf:types`). Absent under any other preset.
declare module 'h3' {
	interface H3EventContext {
		cloudflare?: {
			env: Env;
			context: ExecutionContext;
			request: Request;
		};
	}
}

export {};
