# shop-keepr

A Nuxt 4 application deployed as one Cloudflare Worker with one D1 database. The MVP spec is `docs/spec.md`; the glossary is `CONTEXT.md`; the reasoning is in `docs/adr/`.

## Requirements

- Node `>=22` (see `.nvmrc`)
- pnpm `12.3.4` (pinned via `packageManager`; run `corepack enable`)

## Setup

```bash
pnpm install      # also runs `nuxt prepare` and `wrangler types`
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET to any long random string
pnpm db:migrate   # apply the migrations to the local D1 under .wrangler/state
pnpm auth:seed --email counter@example.test --password 'a long password'   # the shared store login
```

The D1 database itself is created once per environment, with the region hint the store trades from (it cannot change later); the production one exists, in Oceania:

```bash
wrangler d1 create shop-keepr --location oc
```

Its `database_id` is in `wrangler.jsonc`. Local dev and tests never touch it; they use the D1 under `.wrangler/state`.

## Development

```bash
pnpm dev          # dev server on http://localhost:3000, bindings emulated via wrangler
pnpm build        # production build: a Worker in .output/server, assets in .output/public
pnpm preview      # preview the production build
```

`GET /api/staff/health` reads the Store row from D1 and is the first thing to check when a binding looks wrong; it needs a staff session, so sign in at `/login` first.

## Database

Drizzle (`drizzle-orm/d1`) over D1. The schema lives in `server/db/schema/`; migrations are generated, never pushed.

```bash
pnpm db:generate         # drizzle-kit generate, then rewrite CREATE TABLE to STRICT
pnpm db:migrate          # wrangler d1 migrations apply --local
pnpm db:migrate:remote   # the same against the real database
pnpm cf:types            # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

Conventions (spec §4.1): every table is `STRICT`; ids are opaque ULIDs from `newId()`; `store_id` is on every store-owned table; timestamps are epoch-ms integers; money is an integer of minor units. Condition, Language, `Money` and the error codes are defined once in `shared/` and imported by the schema through the column builders in `server/db/columns.ts`.

## Staff auth and the shell

Staff sign in once at `/login` with the one shared store login and land on Lookup inside the sidebar shell (spec §7.1, §8.1; ADR 0015). Better Auth email + password with a DB-backed session and `cookieCache` off, so deleting the `session` row logs that browser out on its next request. The auth tables (`user`, `session`, `account`, `verification`) live in the same D1 database through Better Auth's own Kysely/D1 path, not the Drizzle adapter, and are migrated programmatically:

```bash
pnpm auth:migrate            # create or update the auth tables in the local D1 (part of `pnpm db:migrate`)
pnpm auth:migrate --print    # the SQL for a remote database: pipe to `wrangler d1 execute shop-keepr --remote --file`
pnpm auth:seed --email … --password …   # set the shared login; resets the password and revokes every session (--remote: production)
pnpm auth:check              # the resolved @better-auth/utils is ≥ 0.4.1 (CI runs this)
```

`server/auth/auth.ts` builds an instance over any D1 (`createAuth`, `runAuthMigrations`, `provisionStaffLogin`); `server/auth/instance.ts` is the Worker's singleton, built at module scope from `cloudflare:workers` with its `$context` initialised eagerly (better-auth#10315) and reached only through `useAuth()`. `BETTER_AUTH_SECRET` is a Worker secret (`wrangler secret put`), `.dev.vars` locally. Workers Paid is required: the Free plan's CPU budget cannot fit scrypt.

Every API request is placed on a surface by `server/middleware/surface.ts` from the table in `server/auth/surface.ts`: `/api/staff/**` admits only a staff session (the principal is on `event.context.staff`), `/api/kiosk/**` admits only a kiosk key (none exists yet, so nothing), `/api/auth/**` and Nuxt Icon's data are open, and any other `/api` path is 404 whatever handler sits behind it. Pages are gated by `app/middleware/auth.global.ts`.

The shell is Nuxt UI's dashboard layout (`app/layouts/default.vue`): the sidebar in the spec's nav order (`app/utils/staff-nav.ts`), one banner slot above the page (`useBanner()`), one `UDashboardPanel` per page (`StaffPage`), `Cmd+K` for the page-jump palette and `/` to focus the page's search box (`registerSearchBox`). Every nav item has a page; all but Lookup are empty until their tickets land.

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
pnpm catalogue:seed --kind market_price              # the Market Price walk instead (see below)
```

The seed drives the same sync module inline against the D1 under `.wrangler/state` that `pnpm dev` uses. The module's hash-compare, cursor ordering and quarantine rules are unit-tested against the fixture (`test/unit/catalogue/sync/`); the whole run is tested inside workerd against a real D1 (`test/db/catalogue-sync.test.ts`).

## Market Price and the stepped exchange rate

The Market Price run (`runMarketPriceSync`, kind `market_price`) is the Catalogue's second walk on the same cursor rules: price movements only, per Game System, on a cursor and a lock of its own, so a failed or quarantining Catalogue run never stalls it. It writes `printing.market_price` only when the value differs from the one held, so `market_price_updated_at` means _moved_ and is the reprice sweep's watermark; the game's search-table copy and the verbatim `printing_detail` record follow in the same batch, so a full Catalogue walk afterwards finds no drift. A null Market Price never overwrites a good one: the record is quarantined with reason `null_market_price`, the run finishes `completed_with_drift`, and the gap is logged loudly. A movement for a Printing the Mirror does not hold is skipped and counted in `sync_run.records_skipped`, since the Printing record carries its own Market Price and the Catalogue walk brings it. Tested in `test/db/market-price-sync.test.ts` and `test/unit/catalogue/sync/market-price.spec.ts`.

The exchange rate (ADR 0003) converts a Market Price into the Store's currency in the pipeline's first step and is held as a discrete, versioned value. The hourly cron fetches each pair the Mirror prices in (`printing.market_price_currency` against `store.currency`) from Frankfurter (`server/fx/frankfurter.ts`, the ECB's reference rates, no key, behind a `{ fetch, baseURL }` seam) and judges it against the rate in force: it replaces it only when it has moved past `store.fx_step_threshold_pct` (seed 2 %), and a fetch that fails leaves everything as it was and logs loudly. Every step, fetched or set by hand, is a row in `exchange_rate_step`, the logged event a reprice sweep hangs off. `GET /api/staff/exchange-rate` reads the rates for the System page and `POST /api/staff/exchange-rate` sets one manually (#74 gives it a screen). Tested in `test/db/exchange-rate.test.ts` and `test/unit/fx/`.

## Search

Card-name search is the five-tier cascade of spec §4.3 and ADR 0012, run inside D1 as one `batch()` per search and stopped at the first tier with rows: the folded name exactly, the folded name with its spaces stripped, FTS5 token-AND over the folded name (any order, a subset of the tokens, the last as a prefix), Double Metaphone token-AND for respellings and romanisations, and a per-token trigram resolve of the tokens the vocabulary does not know, AND-ed with the rest, for keyboard slips. Every tier is game-scoped, and every tier takes the same in-stock filter and Facet predicates.

The name keys ship as one small versioned library, `shared/search/name-keys.ts` (`fold`, `foldNoSpace`, `metaphoneKey`, `tokenTrigrams`, `NAME_KEYS_VERSION`), applied to every stored name at sync time and to every query. One module per Game System under `server/search/games/` owns its search table (`mtg_printing`, `pokemon_printing`, `onepiece_printing`, `riftbound_printing`), its typed Facet columns (a multi-valued Facet is one boolean column per value), its index set and its Pricing Attribute registry; nothing outside `server/search/` imports a module, and the sync writes the tables through `server/search/mirror.ts`, which also writes each table's FTS5 index explicitly (an external-content index does not follow its base table) and the shared `token_trigram` vocabulary, all in the same page batch. A Printing counts as held by the sync only when its search row exists at the current `NAME_KEYS_VERSION`, so a search table added to a Mirror that already holds the game, or a bump of the version, is filled or rewritten by the next full walk (`pnpm catalogue:seed`).

The staff route is `GET /api/staff/search?game=magic&q=bolt&inStock=false&facet.rarity=common`; `GET /api/staff/search/options?game=magic` is what the Lookup filter controls are built from, read from `catalogue_set` and `catalogue_vocabulary`, never hardcoded.

```bash
node scripts/search-recall.mjs                # recall per error class on the 38,001 real card names, 300 sampled per class
node scripts/search-recall.mjs --sample 1000
```

Never measure search on a generated corpus (spec §9): the script loads `spike/typo-search/data/all-card-names.json` into an in-memory D1 through the same write side the sync uses and applies the spike's thirteen error classes.

## Checks

```bash
pnpm lint         # eslint (antfu config, tabs + semicolons)
pnpm lint:fix     # eslint --fix
pnpm typecheck    # vue-tsc via nuxt typecheck
pnpm test         # vitest: `unit` (Nuxt environment) and `db` (workerd + local D1)
pnpm test:e2e     # playwright against the built Worker served by `wrangler dev`
```

`pnpm test:e2e` builds first, applies the migrations, seeds the e2e store login (`test/support/staff-login.ts`), then starts `wrangler dev` on port 8787; set `CI=1` to refuse an already-running server. Every db test starts from an empty D1 with the migrations applied.

GitHub Actions (`.github/workflows/ci.yml`) runs `pnpm catalogue:contract:check` and `pnpm auth:check` so far; the rest of the pipeline is deployment fog (spec §10.1).

## Agents

Conventions for AI agents working in this repo live in `AGENTS.md` and `docs/agents/`.
