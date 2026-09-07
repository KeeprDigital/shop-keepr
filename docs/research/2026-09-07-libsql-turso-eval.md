# Research: libSQL / Turso as a D1 alternative

- **Issue:** [#18](https://github.com/KeeprDigital/shop-keepr/issues/18) (challenges the closed D1 decision on [#2](https://github.com/KeeprDigital/shop-keepr/issues/2); workload set by [#6](https://github.com/KeeprDigital/shop-keepr/issues/6))
- **Date:** 2026-09-07
- **Status:** resolved
- **Compares against:** [`2026-09-07-cloudflare-data-layer.md`](./2026-09-07-cloudflare-data-layer.md) (on `main`) and `docs/research/2026-09-07-d1-search-capabilities.md` (**on branch `research/d1-search`, not yet merged** — every relative link to it or to `spike/d1-search/` below resolves only once that branch lands)
- **Spike:** [`spike/turso-eval/`](../../spike/turso-eval/). Every measured number below comes from it.

Issue #18 observes, correctly, that #2 never evaluated libSQL/Turso — the one option that would
preserve the SQLite dialect and therefore all existing schema, Drizzle usage and spike work.
This document evaluates it. Documentation was fetched live from primary sources on 2026-09-07;
measurements were taken locally the same day. The burden was placed on the alternative.

---

## Verdict

**libSQL/Turso does not clearly beat D1 for this workload, and on the constraint that actually
binds it is worse. Stay on D1.**

The evaluation turns on a fact #18 could not have known: **Turso is two databases, and neither
of them is the one #18 is asking for.**

- **libSQL** — the SQLite fork — has everything shop-keepr needs and removes several real D1
  limits. But Turso's own documentation says: _"If you're starting a new project, we recommend
  Turso Database."_ Adopting libSQL means adopting the engine its vendor steers new projects away
  from.
- **Turso Database** — the Rust rewrite Turso does recommend — **has no FTS5.** Measured:
  `no such module: fts5`. FTS5 is the capability #13's spike (`docs/research/2026-09-07-d1-search-capabilities.md`, branch `research/d1-search`)
  measured as load-bearing for the Catalogue mirror (name search over 150k rows in 1–6 ms at 39
  rows read). On Turso Cloud that engine is additionally in **early preview**.

So the choice is a deprecating engine or a preview engine that cannot do the search. Meanwhile
the two headline reasons to want Turso both evaporate on inspection: **`ATTACH` is "deprecated
for all new users"** — the exact limit #18 hoped it would lift — and **embedded replicas cannot
run on Cloudflare Workers at all**, because there is no filesystem.

The one thing Turso genuinely adds, interactive transactions, was measured against #4's oversell
scenario and **made the design worse, not better**: correct, but with 24 of 25 concurrent racers
failing on `SQLITE_BUSY`, against zero failures for the single conditional statement D1 forces.

---

## Point-by-point against #18's questions

### 1. Does it remove D1's specific limits?

Measured against the two engines, alongside the D1 figures from
`2026-09-07-d1-search-capabilities.md` (branch `research/d1-search`).

| D1 limit (measured)                     | libSQL (measured)          | Turso Database (measured)                        | Turso Cloud (documented)                                                 |
| --------------------------------------- | -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `ATTACH` — refused, `SQLITE_AUTH`       | **works**                  | experimental flag only                           | **"deprecated for all new users"**                                       |
| Temp tables — refused, `SQLITE_AUTH`    | **works**                  | **works**                                        | not documented                                                           |
| Bound parameters — exactly 100          | **≥ 1,000**                | **≥ 1,000**                                      | not documented                                                           |
| Compound `SELECT` terms — 5, undocumented | **≥ 500**                | ≥ 1,000, **segfaults at 5,000**                  | not documented                                                           |
| Statement length — 100,000 bytes        | **≥ 50 MB**                | ≥ 10 MB                                          | not documented                                                           |
| FTS5 — fully present, all tokenizers    | **fully present**          | **`no such module: fts5`**                       | libSQL: yes. Turso DB: no                                                |
| FTS5 blocks `wrangler d1 export`        | n/a — different tooling     | n/a                                              | export is per-database, no virtual-table exclusion documented            |
| 10 GB per database, unraisable          | file-system bound          | file-system bound                                | plan storage quota (5–50 GB), no per-database hard cap documented        |

Three of these are real wins for libSQL and worth stating plainly: **the 100-bound-parameter cap
and the undocumented 5-term compound-`SELECT` cap are gone**, and the 100,000-byte statement
limit with them. Those are the caps that forced the D1 spike's conclusions "bulk seed with
inlined literals" and "multi-select facets use `IN`, never `UNION`". On libSQL neither
workaround would be needed.

But look at what they buy. All three are *seed-path and query-shape* annoyances the D1 spike
already solved, at a cost of one paragraph in the build checklist each. None of them is a
correctness risk, none blocks a feature, and none has a runtime cost. Trading vendor
consolidation for them is not a trade #2's reasoning would make.

**`ATTACH` is the one that mattered, and it is gone.** #6's constraint 1 — mirror and stock must
be co-located in one database — is the constraint #18 most wanted lifted, and
[Turso's own docs](https://docs.turso.tech/features/attach-database) say verbatim:

> "This feature is now deprecated for all new users. Existing paid users can continue to use `ATTACH`"

And even for those grandfathered in, it is heavily fenced:

> "The attached databases are read only"
> "You can only attach databases belonging to a group, and in the same group"
> "There is a maximum of 10 databases that can be attached to a single transaction"

This was announced in [Turso's January 2025 platform post](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap):
_"We'll be removing Multi-DB schemas and database `ATTACH` capabilities for new users."_
shop-keepr is a new user. **#6's constraint 1 survives a move to Turso unchanged.** That single
finding removes most of #18's motivation.

**The 10 GB ceiling.** Turso publishes no equivalent hard per-database cap; storage is a plan
quota (5 GB free, 9 GB at $4.99, 24 GB at $24.92, 50 GB at $416.58). So the ceiling is
softer — you buy your way up rather than hitting a wall Cloudflare says
_"cannot be further increased"_. Real, but weightless here: the measured searchable mirror is
**96 MB**, about 1% of D1's ceiling. #2 already called this ceiling unreachable for one store,
and #13's measurement confirmed it with two orders of magnitude to spare.

**FTS5 and the export limitation.** On libSQL, FTS5 is fully present — every tokenizer, external
content, `bm25()`, `snippet()`, `highlight()`, `fts5vocab` — measured identical to D1. Turso does
not document an FTS5-shaped export exclusion the way Cloudflare does, so the "an FTS5 table
makes the whole database non-exportable" cost would probably not follow. **Unverified**: no
Turso page fetched addresses virtual tables and `turso db export` at all, so this is an absence
of a documented restriction, not a documented absence of one.

**On Turso Database, FTS5 is simply gone.** [`COMPAT.md`](https://github.com/tursodatabase/turso/blob/main/COMPAT.md),
which the docs name as _"The authoritative compatibility reference"_, states:

> Turso implements FTS using Tantivy instead of SQLite's FTS3/FTS4/FTS5.
>
> | SQLite FTS3/FTS4/FTS5 | ❌ No | Use Turso FTS instead |

Measured, `@tursodatabase/database@0.7.2` (published 2026-09-04, three days before this
research): `CREATE VIRTUAL TABLE … USING fts5(name)` → `Parse error: no such module: fts5`.
The replacement is `CREATE INDEX … USING fts`, Turso-specific syntax, gated behind
`--experimental-index-method`, and described in
[Turso's own announcement](https://turso.tech/blog/beyond-fts5) (2026-01-27) as
_"available on the main branch in the CLI, behind the `--experimental-index-method` flag."_
Drizzle does not model it. `snippet()` is absent. This is not a port of #13's search work; it is
a rewrite of it against an experimental, non-standard, single-vendor index.

Other gaps measured on Turso Database, listed because they are the sort of thing that surfaces
three months into a build: `WITH RECURSIVE` — `Recursive CTEs are not yet supported`; `lag()`
and `lead()` — `no such function: lag`; generated columns — behind
`--experimental-generated-columns`; `rtree` — `no such module`. And a **segfault**: a 5,000-term
compound `SELECT` kills the process (exit 139, no output, reproduced 3/3). libSQL rejects the
same input cleanly. Nobody would write that query — record it as a maturity signal, not a
workload risk.

### 2. Transactions

**Yes, libSQL has real interactive transactions.** `transaction('write')` issues `BEGIN
IMMEDIATE`; `read` issues `BEGIN TRANSACTION READONLY`; `deferred` issues `BEGIN DEFERRED`
([SDK reference](https://docs.turso.tech/sdk/ts/reference)). D1 has nothing equivalent.

**And it makes #4's design worse.** Measured, 25 concurrent clients racing for one unit of stock,
40 iterations, the same scenario `spike/d1-hold-atomicity` used:

| Approach                                     | Oversold  | Granted/iter | Errors    |
| -------------------------------------------- | --------- | ------------ | --------- |
| Naive read-then-write (**negative control**) | **40/40** | 25.00        | 0         |
| Interactive transaction (`BEGIN IMMEDIATE`)  | 0/40      | 1.00         | **960**   |
| Single conditional statement (D1's pattern)  | 0/40      | 1.00         | **0**     |

The negative control overselling maximally — all 25 racers winning, every iteration — is what
makes the other two rows credible: the harness genuinely interleaves.

Both correct approaches are correct. The difference is the error column. Every one of those 960
errors is `SQLITE_BUSY: database is locked` — **24 of 25 racers per iteration**. An interactive
transaction takes an exclusive write lock and other writers *fail* rather than queue, so the
application must own a retry-with-backoff loop, a retry budget, and a user-visible failure mode
when the budget runs out. The single conditional statement has none of that. It is one
round trip, it always returns an answer, and the answer is correct.

Now add the network. From a Worker, an interactive transaction is not local. The
[serverless driver's own README](https://www.npmjs.com/package/@tursodatabase/serverless)
states that inside a `conn.transaction(...)` callback _"the `BEGIN`/`COMMIT`/`ROLLBACK` requests
are issued by the transaction wrapper itself"_ — each its own HTTP request — while an atomic
batch _"sends the whole transaction as a single HTTP request"_. So a two-statement hold
reservation costs **four HTTP round trips from a Cloudflare colo to an AWS region**, holding a
database-wide write lock for the whole flight, against **one** for the conditional statement.
The [SDK reference](https://docs.turso.tech/sdk/ts/reference) adds a
**5-second timeout** on interactive transactions.

**Answer to #18's question: it complicates the verified design and buys nothing.** #4's
resolution — a single conditional `INSERT … SELECT … WHERE available >= ?` — is not a workaround
for a missing D1 feature. It is the better implementation on both engines. The one thing that
would change is the `.batch()` conditionality trap the #4 spike found (a follow-on statement
still runs when the conditional insert inserted nothing); an interactive transaction would let
you branch in JavaScript instead of carrying `AND EXISTS (...)` into every dependent statement.
That is a modest readability gain, paid for with a lock, a timeout and a retry loop.

libSQL has no `BEGIN CONCURRENT` (measured: `near "CONCURRENT": syntax error`). Turso Database
does, but only under MVCC (measured: `Concurrent transaction mode is only supported when MVCC is
enabled`), and it is irrelevant here regardless — shop-keepr is effectively single-writer.

### 3. Workers integration

**The driver story is good.** `@tursodatabase/serverless@1.4.0` is
_"A serverless database driver for Turso Cloud, using only `fetch()`"_, has **zero runtime
dependencies**, and names Cloudflare Workers explicitly. `@libsql/client/web` is the equivalent
for the libSQL client. There is no TCP requirement, no connection pool, no `nodejs_compat`
requirement. On this axis Turso is straightforwardly better than Hyperdrive, which #2 rejected
partly for not running under `wrangler dev` at all — the equivalent check #18 asked for comes
out **clean**: a fetch-only driver behaves identically under `wrangler dev` and in production,
because it is the same HTTP call either way.

Two things pull the other way.

**There is no Cloudflare Workers guide.** The [docs sitemap](https://docs.turso.tech/sitemap.xml)
carries framework guides for Astro, Elysia, Hono, Next.js, Nuxt, Quasar, Qwik, Remix and
SvelteKit, and an integration page for Vercel. **There is no Cloudflare page of any kind**, and
`docs.turso.tech/sdk/ts/guides/cloudflare*` 404s. The Nuxt guide exists but assumes a Node
runtime: it installs `@libsql/client` (the native-binding package, not `/web`) and never
mentions Nitro presets, edge runtimes or Cloudflare. So the specific combination shop-keepr
would ship — Nuxt 4 + Nitro + Cloudflare Workers + Turso — is documented by neither vendor.
That is not the open Nitro bug #2 found for Hyperdrive
([nitrojs/nitro#3893](https://github.com/nitrojs/nitro/issues/3893)); it is an absence of
guidance rather than a known defect, and the fetch-only driver makes it low-risk. But it is not
a supported path either.

**Every query leaves Cloudflare's network.** Turso Cloud runs in six AWS regions
([locations API](https://docs.turso.tech/api-reference/locations/list)): `aws-us-east-1`,
`aws-us-east-2`, `aws-us-west-2`, `aws-eu-west-1`, `aws-ap-northeast-1`, `aws-ap-south-1`. For a
UK store the nearest is Ireland. D1's binding stays inside Cloudflare, and D1's location hint
(`weur`) places the primary near the store. See [question 7](#7-read-latency-from-a-worker).

### 4. Drizzle support, and migration effort

**Drizzle support is first-class and the API surface is nearly identical.** `drizzle-orm@0.45.2`
ships `drizzle-orm/libsql` with `/web`, `/http`, `/ws`, `/node`, `/wasm` and `/sqlite3`
variants; `drizzle-kit` has a `turso` dialect. Both `LibSQLDatabase` and `SQLiteD1Session`
expose `batch()` and `transaction()`, both over the same `sqlite-core` schema builder. **The
schema does not change at all.**

**The honest migration estimate is therefore very small — and that cuts against #18, not for
it.** The repository currently has **no Drizzle dependency, no D1 binding and no data-layer code
at all**: `package.json` lists neither `drizzle-orm` nor `@cloudflare/workers-types`, and
`nuxt.config.ts` has no database configuration. The only D1-specific artefacts are two throwaway
spikes under `spike/`. So "migration effort" is close to zero **in either direction**, which
means it is not evidence for switching. The cost of being wrong about D1 later is also small,
and #2 already reasoned about exactly this: start where the cheap exit is.

Two divergences worth naming for whoever does port something:

- **`drizzle-orm/d1` returns D1's `meta`** (`changes`, `rows_read`, `rows_written`,
  `total_attempts`); libSQL returns `rowsAffected` / `rowsRead` / `rowsWritten` on a `ResultSet`.
  #4's reservation checks `meta.changes` to decide whether a hold was granted, so that line
  changes shape. `spike/turso-eval/holds.mjs` uses `rowsAffected` and works.
- **Migrations are a different tool.** D1 has `wrangler d1 migrations` as a first-party workflow;
  Turso would use `drizzle-kit` plus its own CLI. Turso Cloud additionally makes
  `PRAGMA user_version` **read-only** ([limitations](https://docs.turso.tech/cloud/limitations)),
  recommending a `_schema_version` table instead — a small but real difference from stock SQLite
  tooling.

### 5. Operations

| | D1 | Turso Cloud |
| --- | --- | --- |
| Point-in-time recovery | **30 days**, minute granularity, **always on**, no extra cost | **1 day free / 10 days ($4.99) / 30 days ($24.92) / 90 days ($416.58)** |
| Restore target | in place | **a new database**, new connection string, new auth token |
| Export | `wrangler d1 export`, blocked by FTS5 virtual tables | `turso db export`; virtual-table behaviour **unverified** |
| Migrations | `wrangler d1 migrations`, first-party | `drizzle-kit` + Turso CLI; `PRAGMA user_version` read-only |
| Idle behaviour | none | **free-plan databases archived after 10 days of inactivity** |

The PITR difference is the sharp one.
[Turso's PITR docs](https://docs.turso.tech/features/point-in-time-recovery) are explicit:
_"Restoring from a PITR creates a new database"_, you cannot restore into an existing one, a new
auth token is required, and _"Restores count towards your plan's database quota"_. So recovery
is not "put it back"; it is "stand up a new database, re-point the Worker, re-issue
credentials". D1's Time Travel restores in place and is on by default for 30 days at no cost.
**Matching D1's retention window costs $24.92/month.**

**Embedded replicas — the thing that makes libSQL interesting — cannot be used here.**
[The docs](https://docs.turso.tech/features/embedded-replicas/introduction) state:
_"In certain contexts, such as serverless environments without a filesystem, you can't use
embedded replicas."_ Cloudflare Workers has no filesystem. Every supported deployment guide
Turso publishes for them (Fly, Koyeb, Railway, Render, Akamai) is a long-lived container
platform. **Answer to #18's question: it would mean nothing here, for one store or a hundred.**
D1's read replication, by contrast, is built into D1 at no extra storage or compute cost, if it
is ever wanted.

Observability was not separately evaluated and is recorded as **unverified**; nothing found
suggests either product is notably ahead.

### 6. The second-vendor cost

**Money.** D1 on Workers Paid: 25 billion rows read and 50 million written per month included,
first 5 GB storage included, Time Travel free. #13 measured the heaviest common query at ~6,000
rows read and a full 150k re-seed at ~1.35M rows written — **2.7% of the monthly write
allowance**, and enough read allowance for roughly 4 million storefront queries a month. The
marginal cost of shop-keepr on D1 is **zero**, on a bill the project is already paying.

Turso's free plan (500M rows read, 10M written, 5 GB) would also cover the workload on volume
alone — but it carries **1-day** PITR and **archives databases after 10 days of inactivity**,
neither acceptable for a store's system of record. The plan that matches D1's 30-day recovery is
**Scaler, $24.92/month**. So the realistic figure is **~$300/year for capabilities D1 already
provides free**, plus a second dashboard, a second set of credentials, a second status page and
a second upgrade cadence.

This is almost exactly the shape #2 rejected Postgres for, and #18 is right that the shape
should be quantified rather than asserted. Quantified, it is worse than it looks: the money is
small, but it buys nothing this workload needs.

**Availability.** Turso publishes a **99.95% uptime SLA**. Its
[status page](https://status.turso.tech/) shows five incidents in the ~50 days before
2026-09-07 — Turso API 502s (48 min, 2026-08-03), `aws-us-east-1` (15 min, 2026-08-16),
`aws-us-west-2` (17 min, 2026-08-25), Dallas (19 min, 2026-07-21), Frankfurt (3 min,
2026-07-17) — with 90-day uptime of 99.986–100% per region. That is a normal, honest operating
record and not an argument against Turso on its own.

**What breaks that would not break on D1.** A Turso outage takes down the ledger, the mirror,
search, holds and the kiosk — the whole application — because there is no local fallback in a
Worker (no embedded replica, no filesystem). On D1 the same is true of a D1 outage. The
difference is not blast radius; it is that Turso adds a **second independent failure domain and
a network path between them**. shop-keepr on D1 fails when Cloudflare fails. shop-keepr on Turso
fails when Cloudflare fails **or** when Turso fails **or** when the path between them degrades.
For a store whose stated posture (from #6) is "API down means the tool is down, which the store
accepts", adding a failure domain buys nothing and costs one.

### 7. Read latency from a Worker

**This is the finding that should decide it, and it is the one that could not be measured.**

D1's binding resolves inside Cloudflare's network, to a primary placed by location hint near the
store. Turso Cloud is reached by HTTPS from a Cloudflare colo to one of six AWS regions —
Ireland, for a UK store. That is a real network hop on **every kiosk query**, on top of Turso's
own storage path: its [diskless architecture post](https://turso.tech/blog/turso-cloud-goes-diskless)
(2025-04-07) reports S3 Express at **3.8 ms average for a 4 KB read** and standard S3 at
**19 ms**, before any application query cost.

Neither vendor publishes comparable colo-to-database latency figures, so no honest number can be
put on the difference. But the direction is not in doubt, and it compounds: the interactive
transaction that is Turso's main advantage costs **four** of those round trips where D1's
conditional statement costs one.

Against #13's measured D1 query costs — 1–6 ms for FTS5 name search, 5 ms for the faceted
in-stock price-sorted query — a cross-network hop is not a rounding error. It is plausibly the
dominant term. **Recorded as the single most important unverified claim in this document**, and
as the thing that would have to come out *strongly* in Turso's favour to overturn the
recommendation. Nothing found suggests it would.

---

## Where #18 is right

Stated plainly, because the ticket asked for adversarial treatment in both directions:

- **#2 genuinely did not evaluate libSQL/Turso**, and it was the option most worth evaluating.
  This document exists because that gap was real.
- **libSQL removes three measured D1 limits outright**: the 100-bound-parameter cap, the
  undocumented 5-term compound-`SELECT` cap, and the 100,000-byte statement limit. #13's
  "inline escaped literals for the bulk seed" and "never `UNION`, always `IN`" workarounds would
  both be unnecessary.
- **The size ceiling is softer.** No documented unraisable per-database cap.
- **Interactive transactions are real**, and D1 has nothing like them.
- **The driver is a better fit for Workers than Hyperdrive ever was**: fetch-only, zero
  dependencies, identical under `wrangler dev`.
- **Drizzle portability is genuine.** The schema is unchanged; the migration is small.

None of that overcomes: `ATTACH` deprecated for new users, no FTS5 on the recommended engine,
no embedded replicas on Workers, PITR that creates a new database and costs $24.92/month to
match D1's window, a second failure domain, and a network hop on every kiosk query.

## Where #18's framing does not hold

- **"It would preserve all existing schema, Drizzle usage and spike work."** Partly. It preserves
  the schema. It does **not** preserve the spike work if Turso Database is chosen, because FTS5
  is absent — and Turso Database is what Turso recommends for new projects. Choosing libSQL to
  keep FTS5 means adopting the engine the vendor is steering away from.
- **"Does it remove D1's limits?"** The limit #18 leads with — `ATTACH`/cross-database queries —
  is **not removed**. It is deprecated for new users on Turso and permanently refused on D1. Same
  outcome, and #6's constraint 1 stands either way.

---

## What remains unverified

**No Turso account was created, no database was provisioned, and no money was spent**, per this
research's ground rules. The spike ran the two engines locally. That is the same boundary the
[#4](../../spike/d1-hold-atomicity/README.md) and #13 (`spike/d1-search/`, branch `research/d1-search`) spikes drew, and
it is left open deliberately rather than papered over.

Outstanding obligations for a human, in priority order:

1. **Wall-clock read latency from a Cloudflare Worker to `aws-eu-west-1`, against D1 in `weur`.**
   The decisive number, and the only one that could plausibly change the recommendation. Nothing
   in this document measures it.
2. **Turso Cloud's own limits.** Bound parameters, statement length, compound `SELECT` terms,
   request/response size and query duration are **undocumented on every Turso page fetched**. The
   libSQL figures above are the *engine's*; the service may cap lower. Cloudflare documents all
   of these for D1.
3. **Whether `turso db export` works with FTS5 virtual tables.** No Turso page addresses it.
   D1's equivalent restriction is documented and severe.
4. **Whether Turso Cloud's libSQL build carries the same FTS5 surface measured locally** —
   tokenizers, external content, `fts5vocab`. The
   [extensions page](https://docs.turso.tech/features/sqlite-extensions) lists FTS5 as preloaded
   but gives no detail.
5. **Nuxt 4 + Nitro + Cloudflare preset + `drizzle-orm/libsql/web` end to end.** Documented by
   neither vendor. Low risk given a fetch-only driver, but untested.
6. **libSQL's actual maintenance trajectory.** "Actively maintained, but new features are being
   developed in Turso" is the vendor's phrasing, not a support commitment or an EOL date.

Also worth naming: the engine versions move fast. `@tursodatabase/database@0.7.2` was published
**three days** before this research. Several of its gaps (recursive CTEs, `lag()`, FTS) are
plainly work in progress, and a re-evaluation in six months could read very differently. That is
an argument for revisiting, not for adopting now.

---

## Recommendation

**Stay on D1. Do not adopt libSQL/Turso.** Close #18 as evaluated-and-rejected rather than
unexamined, and record the three limits libSQL would have lifted so nobody re-litigates them
from memory.

Two things worth carrying forward regardless:

1. **The reasons to reconsider are now specific**, so a future revisit is cheap: FTS5 (or an
   equivalent Drizzle understands) landing as stable on Turso Database; a Cloudflare-region or
   Cloudflare-adjacent Turso deployment that removes the network hop; or shop-keepr genuinely
   needing more than 10 GB. None applies today.
2. **Keep the exits open exactly as #2 prescribed** — money as integer minor units, timestamps as
   epoch-ms integers, `storeId` on every store-owned table, the sync job written against *a*
   binding. Those keep both the Postgres door and the libSQL door open, and they cost nothing.

---

## Sources

Turso (primary, all fetched 2026-09-07):

- [Introduction](https://docs.turso.tech/introduction) · [libSQL](https://docs.turso.tech/libsql) · [Turso Cloud](https://docs.turso.tech/turso-cloud) · [Pricing](https://turso.tech/pricing) · [Usage & billing](https://docs.turso.tech/help/usage-and-billing) · [Cloud limitations](https://docs.turso.tech/cloud/limitations)
- [ATTACH database](https://docs.turso.tech/features/attach-database) · [Embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction) · [Point-in-time recovery](https://docs.turso.tech/features/point-in-time-recovery) · [SQLite extensions](https://docs.turso.tech/features/sqlite-extensions) · [Locations](https://docs.turso.tech/api-reference/locations/list) · [Local development](https://docs.turso.tech/local-development)
- [TS SDK reference](https://docs.turso.tech/sdk/ts/reference) · [Drizzle](https://docs.turso.tech/sdk/ts/orm/drizzle) · [Nuxt guide](https://docs.turso.tech/sdk/ts/guides/nuxt) · [Transactions](https://docs.turso.tech/sql-reference/statements/transactions) · [Compatibility](https://docs.turso.tech/sql-reference/compatibility) · [sitemap.xml](https://docs.turso.tech/sitemap.xml)
- [`COMPAT.md`](https://github.com/tursodatabase/turso/blob/main/COMPAT.md), named by the docs as the authoritative compatibility reference — the source of the FTS5, recursive-CTE and window-function findings
- [`tursodatabase/libsql` README](https://github.com/tursodatabase/libsql) — _"actively maintained, but new features are being developed in Turso"_
- Blog: [Upcoming changes to the Turso Platform and Roadmap](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap) (2025-01-21) · [Beyond FTS5](https://turso.tech/blog/beyond-fts5) (2026-01-27) · [Turso Cloud Goes Diskless](https://turso.tech/blog/turso-cloud-goes-diskless) (2025-04-07) · [Introducing the Turso Serverless JavaScript Driver](https://turso.tech/blog/introducing-turso-serverless-javascript-driver) (2025-07-31)
- [Status page](https://status.turso.tech/)
- `@tursodatabase/serverless@1.4.0` README (npm tarball), for the per-statement HTTP round-trip behaviour of interactive transactions

Cloudflare (via the two prior research documents, re-checked not re-fetched):

- [`2026-09-07-cloudflare-data-layer.md`](./2026-09-07-cloudflare-data-layer.md) — D1 limits, pricing, transactions, Time Travel, read replication
- `2026-09-07-d1-search-capabilities.md` (branch `research/d1-search`) — the measured D1 behaviour every comparison above is drawn against

Measurements:

- [`spike/turso-eval/`](../../spike/turso-eval/): `probe-libsql.mjs`, `run-turso-probes.sh` (capability and ceiling probes on both engines), `holds.mjs` (the three-way oversell scenario)
