// The Cloudflare bindings Nitro attaches to every request, typed from the
// generated worker-configuration.d.ts at the repo root (`pnpm cf:types`).
declare module 'h3' {
	interface H3EventContext {
		cloudflare: {
			env: Env;
			context: ExecutionContext;
			request: Request;
		};
	}
}

export {};
