# shop-keepr

A Nuxt 4 application deployed as one Cloudflare Worker with one D1 database. The MVP spec is `docs/spec.md`; the glossary is `CONTEXT.md`; the reasoning is in `docs/adr/`.

## Requirements

- Node `>=22` (see `.nvmrc`)
- pnpm `12.3.4` (pinned via `packageManager`; run `corepack enable`)

## Setup

```bash
pnpm install      # also runs `nuxt prepare` and `wrangler types`
pnpm db:migrate   # apply the migrations to the local D1 under .wrangler/state
```

The D1 database itself is created once per environment, with the region hint the store trades from (it cannot change later):

```bash
wrangler d1 create shop-keepr --location weur
```

Paste the printed `database_id` into `wrangler.jsonc`. Local dev and tests never need a real id.

## Development

```bash
pnpm dev          # dev server on http://localhost:3000, bindings emulated via wrangler
pnpm build        # production build: a Worker in .output/server, assets in .output/public
pnpm preview      # preview the production build
```

`GET /api/staff/health` reads the Store row from D1 and is the first thing to check when a binding looks wrong.

## Database

Drizzle (`drizzle-orm/d1`) over D1. The schema lives in `server/db/schema/`; migrations are generated, never pushed.

```bash
pnpm db:generate         # drizzle-kit generate, then rewrite CREATE TABLE to STRICT
pnpm db:migrate          # wrangler d1 migrations apply --local
pnpm db:migrate:remote   # the same against the real database
pnpm cf:types            # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

Conventions (spec §4.1): every table is `STRICT`; ids are opaque ULIDs from `newId()`; `store_id` is on every store-owned table; timestamps are epoch-ms integers; money is an integer of minor units. Condition, Language, `Money` and the error codes are defined once in `shared/` and imported by the schema through the column builders in `server/db/columns.ts`.

## Catalogue contract

The Catalogue is reached over HTTPS as a named consumer; its generated OpenAPI document is the contract (ADR 0013, spec §5). The document is committed at `server/catalogue/openapi.json` and one pinned generator (`@hey-api/openapi-ts`) turns it into TypeScript types and Zod 4 schemas under `server/catalogue/generated/`, both committed so the build tests offline and contract change lands as a reviewable diff.

```bash
pnpm catalogue:contract            # fetch staging's document, regenerate, then commit both
pnpm catalogue:contract:generate   # regenerate from the committed document
pnpm catalogue:contract:check      # fail if the committed output is stale (CI runs this)
```

`catalogue:contract` reads `CATALOGUE_BASE_URL` and `CATALOGUE_CREDENTIAL` (see `.env.example`). Until the Catalogue has a staging environment serving a document, the committed copy is authored from `docs/catalogue-requirements.md`; the first fetch replaces it and the diff is the contract change.

`server/catalogue/client.ts` is the one code path across the seam: `createCatalogueClient({ fetch, baseURL, credential })`. Production passes the Worker's `fetch`; tests pass `fixtureFetch` from `test/support/catalogue-fixture.ts`, which serves the committed fixture under `test/fixtures/catalogue/` by path. Every fixture record validates against the generated schemas, and a test pins what the fixture must hold (spec §5.6).

## Catalogue Mirror and sync

The Mirror is shop-keepr's copy of the Catalogue (spec §4.2, ADR 0008, ADR 0009): `printing` (shared identity and display), `printing_detail` (the record verbatim plus a content hash), `catalogue_set`, `catalogue_vocabulary`, `sync_run` (history and the lock) and `catalogue_quarantine`. Nothing in it is a fact of shop-keepr's own; the sync module under `server/catalogue/sync/` is the only writer.

One job fills, refreshes and heals it by walking one cursor per (kind, Game System): from cursor zero into an empty Mirror it seeds, from the stored cursor it deltas, from cursor zero into a full Mirror it reconciles. Every write compares the content hash first (hash match is a read, not a write), a record applies only if its cursor is at or after the row's, sets and vocabularies go before Printings, and bulk writes inline escaped literals under D1's 100-parameter and 100 KB caps. A record that fails validation, or carries a colour with no column, lands in `catalogue_quarantine` with its raw payload and the run completes `completed_with_drift`; the run never fails on a record. A withdrawn Printing flips `withdrawn` and keeps its row. A Printing the Mirror holds that a full walk does not return is counted as drift and left untouched: absence is not withdrawal. The Mirror's indexes are built by the run after the walk, not by the migration; a seed (a full walk into a Mirror holding nothing of that Game System) leaves them for the next run, so every Game System seeds bare, and the seed script builds them once every game is in.

`sync_run` is one `running` row per kind, claimed by a conditional insert; a `running` row with no progress for two hours is abandoned by the next claim. The stored cursor for a (kind, Game System) is `cursor_to` of its latest run no longer running, advanced with every applied page. Statuses: `running`, `completed`, `completed_with_drift`, `failed`, `abandoned` (`shared/domain/sync-run.ts`).

In production the run is the `CatalogueSyncWorkflow` Cloudflare Workflow (binding `CATALOGUE_SYNC`, input `{ kind, game, fromCursor? }`), one durable step per page. Nitro cannot add named exports to its entry, so `server/entry.cloudflare.ts` re-exports Nitro's handler alongside the class and `nuxt.config.ts` uses it as the production entry. Starting it (the System page's buttons and the scheduling cron) lands with its own tickets; the Catalogue credentials are the secrets `CATALOGUE_BASE_URL` and `CATALOGUE_CREDENTIAL` (`.dev.vars.example` locally).

```bash
pnpm catalogue:seed                                  # full walk of every Game System in the fixture into the local D1
pnpm catalogue:seed --from staging --game magic      # the same against Catalogue staging (needs .dev.vars)
pnpm catalogue:seed --resume                         # a delta from the stored cursor
```

The seed drives the same sync module inline against the D1 under `.wrangler/state` that `pnpm dev` uses. The module's hash-compare, cursor ordering and quarantine rules are unit-tested against the fixture (`test/unit/catalogue/sync/`); the whole run is tested inside workerd against a real D1 (`test/db/catalogue-sync.test.ts`).

## Checks

```bash
pnpm lint         # eslint (antfu config, tabs + semicolons)
pnpm lint:fix     # eslint --fix
pnpm typecheck    # vue-tsc via nuxt typecheck
pnpm test         # vitest: `unit` (Nuxt environment) and `db` (workerd + local D1)
pnpm test:e2e     # playwright against the built Worker served by `wrangler dev`
```

`pnpm test:e2e` builds first, applies the migrations, then starts `wrangler dev` on port 8787; set `CI=1` to refuse an already-running server. Every db test starts from an empty D1 with the migrations applied.

GitHub Actions (`.github/workflows/ci.yml`) runs only `pnpm catalogue:contract:check` so far; the rest of the pipeline is deployment fog (spec §10.1).

## Agents

Conventions for AI agents working in this repo live in `AGENTS.md` and `docs/agents/`.
