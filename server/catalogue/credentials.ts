/**
 * The Catalogue's base URL and this environment's credential, from the
 * Worker's bindings (ADR 0013): secrets in every deployed environment,
 * `.dev.vars` locally. Read here by the Workflow and by `pnpm catalogue:seed`.
 */
export function catalogueCredentials(env: Pick<Env, 'CATALOGUE_BASE_URL' | 'CATALOGUE_CREDENTIAL'>): { baseURL: string; credential: string } {
	const { CATALOGUE_BASE_URL: baseURL, CATALOGUE_CREDENTIAL: credential } = env;
	if (!baseURL || !credential) {
		throw new Error('CATALOGUE_BASE_URL and CATALOGUE_CREDENTIAL must be set for this environment');
	}
	return { baseURL: baseURL.replace(/\/$/, ''), credential };
}
