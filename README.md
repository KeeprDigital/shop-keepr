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

## Checks

```bash
pnpm lint         # eslint (antfu config, tabs + semicolons)
pnpm lint:fix     # eslint --fix
pnpm typecheck    # vue-tsc via nuxt typecheck
pnpm test         # vitest: `unit` (Nuxt environment) and `db` (workerd + local D1)
pnpm test:e2e     # playwright against the built Worker served by `wrangler dev`
```

`pnpm test:e2e` builds first, applies the migrations, then starts `wrangler dev` on port 8787; set `CI=1` to refuse an already-running server.

## Agents

Conventions for AI agents working in this repo live in `AGENTS.md` and `docs/agents/`.
