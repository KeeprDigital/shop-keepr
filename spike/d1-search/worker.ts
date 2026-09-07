/**
 * Throwaway spike (issue #13). The tests drive the D1 binding directly; this
 * module exists only because `wrangler.jsonc` needs a `main`.
 */
export interface Env {
	DB: D1Database;
}

export default {
	async fetch(): Promise<Response> {
		return new Response('d1-search spike', { status: 200 });
	},
} satisfies ExportedHandler<Env>;
