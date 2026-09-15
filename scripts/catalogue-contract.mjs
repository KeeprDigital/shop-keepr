/**
 * The Catalogue contract layer (ADR 0013; spec §5, _The contract layer_). One pinned generator
 * turns the committed OpenAPI document into TypeScript types and Zod 4
 * schemas; both are committed so the build tests offline and contract
 * change lands as a reviewable diff.
 *
 *   node scripts/catalogue-contract.mjs fetch     fetch staging's document, then generate
 *   node scripts/catalogue-contract.mjs generate  regenerate from the committed document
 *   node scripts/catalogue-contract.mjs check     fail if the committed output is stale
 *
 * `fetch` reads CATALOGUE_BASE_URL and CATALOGUE_CREDENTIAL from the
 * environment; the document is served at `${CATALOGUE_BASE_URL}/openapi.json`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@hey-api/openapi-ts';

const root = new URL('../', import.meta.url);
const DOCUMENT = fileURLToPath(new URL('server/catalogue/openapi.json', root));
const OUTPUT = fileURLToPath(new URL('server/catalogue/generated', root));
const DOCUMENT_PATH = '/openapi.json';

/** Fetches the document as Consumer #1 and returns it pretty-printed. */
async function fetchDocument({ fetch, baseURL, credential }) {
	const response = await fetch(`${baseURL}${DOCUMENT_PATH}`, {
		headers: { accept: 'application/json', authorization: `Bearer ${credential}` },
	});
	if (!response.ok) {
		throw new Error(`Catalogue returned ${response.status} for ${DOCUMENT_PATH}`);
	}
	const document = await response.json();
	if (typeof document?.openapi !== 'string') {
		throw new TypeError(`Not an OpenAPI document: ${JSON.stringify(document).slice(0, 200)}`);
	}
	return `${JSON.stringify(document, null, '\t')}\n`;
}

async function generate(path) {
	await createClient({
		input: DOCUMENT,
		output: { path, clean: true, indexFile: false },
		plugins: ['@hey-api/typescript', { name: 'zod', compatibilityVersion: 4 }],
		logs: { level: 'silent' },
	});
}

function readTree(dir) {
	return Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]));
}

async function check() {
	const fresh = mkdtempSync(join(tmpdir(), 'catalogue-contract-'));
	try {
		await generate(fresh);
		const expected = readTree(fresh);
		const committed = readTree(OUTPUT);
		const stale = [...new Set([...Object.keys(expected), ...Object.keys(committed)])]
			.filter(name => expected[name] !== committed[name]);
		if (stale.length > 0) {
			throw new Error(`Catalogue contract output is stale: ${stale.join(', ')}\nRun \`pnpm catalogue:contract:generate\` and commit the result.`);
		}
		console.log('Catalogue contract output is fresh.');
	}
	finally {
		rmSync(fresh, { recursive: true, force: true });
	}
}

async function main(mode) {
	switch (mode) {
		case 'fetch': {
			const { CATALOGUE_BASE_URL: baseURL, CATALOGUE_CREDENTIAL: credential } = process.env;
			if (!baseURL || !credential) {
				throw new Error('Set CATALOGUE_BASE_URL and CATALOGUE_CREDENTIAL to the Catalogue staging environment.');
			}
			writeFileSync(DOCUMENT, await fetchDocument({ fetch, baseURL, credential }));
			console.log(`Fetched ${baseURL}${DOCUMENT_PATH} -> ${DOCUMENT}`);
			await generate(OUTPUT);
			console.log(`Generated ${OUTPUT}`);
			break;
		}
		case 'generate':
			await generate(OUTPUT);
			console.log(`Generated ${OUTPUT}`);
			break;
		case 'check':
			await check();
			break;
		default:
			throw new Error(`Unknown mode "${mode}"; expected fetch, generate or check.`);
	}
}

await main(process.argv[2] ?? 'fetch');
