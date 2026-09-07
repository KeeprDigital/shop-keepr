# Research: Cloudflare data layer for the movement ledger

- **Issue:** [#2](https://github.com/KeeprDigital/shop-keepr/issues/2) (parent map [#1](https://github.com/KeeprDigital/shop-keepr/issues/1))
- **Date:** 2026-09-07
- **Status:** resolved
- **Interacts with:** [#4](https://github.com/KeeprDigital/shop-keepr/issues/4) (realtime / hold expiry). See [Where Hold state lives](#where-hold-state-lives-boundary-with-4)

Every figure below was fetched live from a primary source on 2026-09-07. Cloudflare limits and pricing move; re-verify anything you are about to design against a ceiling for. Claims that could not be verified from a primary source are marked **unverified**.

---

## Recommendation

**D1, one database, with Drizzle (`drizzle-orm/d1`), `storeId` on every table.**

The trade-off, plainly: D1 caps at **10 GB per database** (a hard cap Cloudflare states cannot be raised) and it has **no interactive transactions**, only atomic `batch()`. It is the only candidate with a ceiling shop-keepr could theoretically hit, and the only one where a future need for read-then-decide-then-write logic inside a transaction would force a rewrite rather than a config change. In exchange: zero ops, zero marginal cost, one vendor, no connection pool, no cold start, no stale-cache trap, always-on 30-day minute-granularity point-in-time recovery, and an official `wrangler` migration workflow. For one physical trading-card store the ceiling is unreachable. A movement row is on the order of 100–200 bytes, so 10 GB is tens of millions of movements. And atomic `batch()` is exactly the primitive an append-only ledger needs: _insert movement + update derived balance_ in one atomic call.

The two alternatives fail for specific, evidenced reasons, not vibes:

- **Postgres via Hyperdrive** answers a problem shop-keepr does not have. Cloudflare's own positioning is _"Connecting to an **existing** database"_. It adds a second vendor and bill, its query cache is **on by default with a 60-second TTL and no write invalidation** (a stale-stock hazard aimed straight at this app), it **does not run at all under `wrangler dev`**, `LISTEN`/`NOTIFY` and advisory locks are unsupported through it, holding a transaction open is documented as a scaling hazard, and there is an **open, undiagnosed Nitro bug** in exactly the Nuxt + Hyperdrive + Drizzle path.
- **Durable Object SQLite** as the _primary_ store has the **same 10 GB ceiling** as D1, so it buys no headroom, and it forfeits the thing kiosk search depends on: there is **no cross-Durable-Object query or fan-out API at all**. Cloudflare's own answer to "I need to query across my data ad-hoc" is: use D1.

---

## The workload, restated

From the map ([#1](https://github.com/KeeprDigital/shop-keepr/issues/1)):

- **Movement**: append-only stock change. Never updated, never deleted.
- **Inventory Item**: SKU (card printing x condition), scoped by `storeId`, carries a quantity.
- **Hold**: TTL reservation against an Inventory Item, created by a **Basket**.
- On-hand is **derived** from the ledger. Available-to-promise = on-hand − active Holds.
- One physical store. Low write rate. Every kiosk search must resolve on-hand.

Shape: overwhelmingly read-heavy, effectively single-writer, small. This is a _small database with a hot read path_, not a scaling problem. The only genuine engineering question is how the read path resolves on-hand cheaply, and that answer is the same in all three candidates (see [Aggregating the ledger](#aggregating-the-ledger)), so it does not discriminate between them.

---

## Candidate 1: D1 (recommended)

### Limits

[d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/) (page last updated 2026-04-21):

| Limit                                             | Workers Paid                         | Workers Free |
| ------------------------------------------------- | ------------------------------------ | ------------ |
| Maximum database size                             | **10 GB**                            | 500 MB       |
| Databases per account                             | 50,000 (raisable by request)         | 10           |
| Storage per account                               | 1 TB                                 | 5 GB         |
| Queries per Worker invocation                     | 1,000                                | 50           |
| Maximum SQL query duration                        | 30 s                                 | 30 s         |
| Maximum SQL statement length                      | 100,000 bytes                        | n/a          |
| Bound parameters per query                        | 100                                  | n/a          |
| Columns per table                                 | 100                                  | n/a          |
| Rows per table                                    | Unlimited (bounded by database size) | n/a          |
| Max string / BLOB / row size                      | 2,000,000 bytes                      | n/a          |
| Simultaneous D1 connections per Worker invocation | 6                                    | n/a          |

Verbatim: _"the 10 GB limit of a D1 database cannot be further increased"_; _"You can open up to six connections (to D1) simultaneously for each invocation of your Worker."_

Three subtleties that matter for the ledger:

- **Per-statement limits apply inside a batch.** _"Limits for individual queries (listed above) apply to each individual statement contained within a batch statement."_ So the 100-bound-parameter cap constrains how wide a bulk `IN (...)` or multi-row `INSERT` can be. Chunk it, or join against a temp/values table rather than binding a long list. This will bite on a kiosk search resolving many SKUs at once.
- **The 30 s duration also applies to the whole batch call**, not just per statement.
- **A D1 database is single-threaded.** _"Each individual D1 database is inherently single-threaded, and processes queries one at a time"_: roughly 1,000 queries/s at 1 ms/query, ~10/s at 100 ms/query. Overload surfaces as `D1 DB is overloaded. Requests queued for too long.` This is a direct consequence of D1 being one Durable Object, and it is orders of magnitude above one store's needs. Record it honestly: _"D1 is single-threaded"_ is **not** a point against DO SQLite, because D1 _is_ a Durable Object.

Note: since **2026-09-01** D1 hard-enforces Free-plan daily row limits: queries fail until midnight UTC once exceeded ([D1 changelog](https://developers.cloudflare.com/changelog/rss/d1.xml)). Run on Workers Paid.

There is a documented inconsistency: the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/#subrequests) gives internal-service subrequests as 1,000 (Free) / "matches configured limit (default 10,000)" (Paid), which conflicts with the D1 page's 1,000/50 queries-per-invocation. Plan against the conservative D1 figure.

### Transactions

**There is no interactive transaction API and no usable explicit `BEGIN`/`COMMIT`.** The D1 docs corpus contains zero mentions of interactive transactions.

[d1/worker-api/d1-database](https://developers.cloudflare.com/d1/worker-api/d1-database/): _"D1 operates in auto-commit."_ And on `batch()`:

> "Our implementation guarantees that each statement in the list will execute and commit, sequentially, non-concurrently."
> "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence."

Explicit transactions are actively rejected. From [import-export-data](https://developers.cloudflare.com/d1/best-practices/import-export-data/): _"If you receive a 'cannot start a transaction within a transaction' error, make sure you have removed `BEGIN TRANSACTION` and `COMMIT` from your dumped SQL statements."_ The reason is stated in [sql-api/foreign-keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/): _"Because D1 runs every query inside an implicit transaction, user queries cannot change this during a query or migration."_

**This is sufficient for the ledger.** Appending a Movement and updating a derived balance is a fixed, known set of statements, with no read-then-decide round trip inside the transaction. Where a decision _does_ depend on a read (e.g. "reject a sale-out that would take on-hand negative"), express it as a conditional `UPDATE ... WHERE on_hand >= ?` inside the batch and check `meta.changes` / `rows_written` on the result, rather than reading first. That is the pattern D1 forces, and it is the correct pattern for a ledger regardless of engine.

Two related behaviours:

- Do **not** conflate the Sessions API with transactions. It is a routing and consistency mechanism, nothing more.
- Since 2025-09-11 D1 **auto-retries read-only queries** (`SELECT`, `EXPLAIN`, `WITH`) up to twice; `meta.total_attempts` reports it. **Writes are not auto-retried**: Cloudflare recommends retrying idempotent writes in application code. Movement inserts should carry an idempotency key so a retry is safe.

### SQL features relevant to a ledger

D1's engine is stock SQLite. Cloudflare does not publish D1's SQLite version on any docs page; `workerd`'s [`MODULE.bazel` on `main`](https://raw.githubusercontent.com/cloudflare/workerd/main/MODULE.bazel) pins `sqlite-src-3530400` (3.53.4) plus six Cloudflare patches. Treat 3.53.4 as strongly indicative but **unverified** for D1's production backend.

Explicitly documented as supported:

- **Partial indexes**: [use-indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/): _"Partial indexes can be faster at read time (less rows in the index) and at write time (fewer writes to the index) than full indexes."_
- **Generated columns**, `STORED` and `VIRTUAL`, from [query-json](https://developers.cloudflare.com/d1/sql-api/query-json/). Three caveats, all verbatim: _"Tables must have at least one non-generated column"_; expressions _"can only reference other columns in the same table and row, and must only use deterministic functions"_; and critically **"Columns added to an existing table via `ALTER TABLE ... ADD COLUMN` must be `VIRTUAL`. You cannot add a `STORED` column to an existing table."** If you ever want a stored rollup column on an existing `movement` table, that is a table rebuild.
- **FTS5** (including `fts5vocab`), the JSON extension, and math functions, from [sql-statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/). FTS5 is directly useful for kiosk card-name search; note _"Export is not supported for virtual tables"_, so an FTS index needs rebuilding after a restore/import rather than being carried in a dump.
- **Foreign keys**, enforced by default, with `ON DELETE CASCADE` / `RESTRICT`. `PRAGMA defer_foreign_keys = on` is the escape hatch, scoped to the current implicit transaction.
- `STRICT` tables (recommended), `EXPLAIN QUERY PLAN`, `PRAGMA optimize`.

**Not explicitly confirmed in D1's own docs** (flagged honestly): window functions, CTEs, `UPSERT`/`ON CONFLICT`, triggers, views. Indirect evidence is strong: the blanket statement _"D1 is compatible with most SQLite's SQL convention since it leverages SQLite's query engine"_, `WITH` appearing in the auto-retry read-only keyword list, the pricing FAQ mentioning _"tables and indexes and triggers"_, `PRAGMA table_list` _"lists tables and views"_, and `PRAGMA recursive_triggers` being supported. They almost certainly all work, but no D1 page states it. **There is no materialized view** in SQLite or D1: a rollup table maintained by the write path (or by triggers) is the only pattern, which is what [Aggregating the ledger](#aggregating-the-ledger) prescribes.

Index guidance worth carrying into the schema: leftmost-prefix rule for composite indexes is documented; _"You cannot create indexes that reference other tables or use non-deterministic functions"_; _"Indexes cannot be updated"_ (drop and recreate); and _"an index is effectively a table itself"_ for storage billing. The anti-pattern table calls out unindexed `WHERE`, unindexed `JOIN` columns, correlated subqueries, `ORDER BY RANDOM()`, and leading-wildcard `LIKE` _"including inside `COUNT(*)`"_.

### Read replication

[d1/best-practices/read-replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), page updated 2026-08-10:

- Opt-in per database: dashboard **Settings → Enable Read Replication**, or REST `read_replication.mode: auto`.
- Requires the **Sessions API** (`db.withSession(...)`) or all queries still go to the primary. Bookmarks give sequential consistency including read-your-own-writes.
- Modes: `first-unconstrained` (default: first query to any instance) and `first-primary`.
- _"All write queries are still forwarded to the primary database instance."_
- Cost: _"D1 read replication is built into D1, so you don't pay extra storage or compute costs for read replicas."_
- Sessions API is Worker-binding-only, _"not yet available via the REST API."_ `served_by_region` / `served_by_primary` are undefined under `wrangler dev`.

**Status is ambiguous.** The docs page carries no beta label, but the only status statement in any changelog is _"public beta"_ from 2025-04-10 and no GA entry exists through 2026-09-01. Do not depend on it for MVP correctness; do use `withSession()` from day one anyway, because it costs nothing and forecloses a read-your-writes bug if replication is ever switched on.

**That protection does not generalise.** A session handle only helps queries that actually route through it, and a third-party library with its own database access will never do so. Per [#3](https://github.com/KeeprDigital/shop-keepr/issues/3), the auth library is exactly such a case. So the `withSession()` convention protects the application schema only, and if replication is ever enabled, any table written by a library outside our query layer has to stay off it.

### Location and latency

[d1/configuration/data-location](https://developers.cloudflare.com/d1/configuration/data-location/):

- Primary is created _"in a location close to where you issued the request to create a database."_ Location hints (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`) are **set at create time only**: `wrangler d1 create <db> --location=weur`. _"Providing a location hint does not guarantee that D1 runs in your preferred location. Instead, it will run in the nearest possible location (by latency) to your preference."_
- Not supported in South America, Africa or the Middle East: _"D1 databases do not run in these locations."_
- Jurisdictions (`eu`, `fedramp`, added 2025-11-05) can only be set at creation and **override** a location hint.
- _"D1 request latency is dependent on the physical proximity of a user to the primary database instance."_

**Action:** create the database with an explicit location hint matching the store's region. It cannot be changed later without recreating the database.

Cloudflare publishes **no same-colo vs cross-ocean millisecond figures** for the Workers binding. The only quantitative numbers are the throughput heuristics above and a REST-API-only "50–500 ms" improvement from 2025-05-30 that does not apply to the binding.

### Pricing

[d1/platform/pricing](https://developers.cloudflare.com/d1/platform/pricing/):

| Metric       | Workers Free | Workers Paid                              |
| ------------ | ------------ | ----------------------------------------- |
| Rows read    | 5M/day       | First **25 billion**/month, then $0.001/M |
| Rows written | 100K/day     | First **50 million**/month, then $1.00/M  |
| Storage      | 5 GB total   | First 5 GB, then $0.75/GB-month           |

Two counting rules that shape the schema:

- **"Rows read" counts rows _scanned_, not returned.** _"if you have a table with 5000 rows and run a `SELECT * FROM table` as a full table scan, this would count as 5,000 rows read."_ And: _"A query that filters on an unindexed column may return fewer rows to your Worker, but is still required to read (scan) more rows."_
- **An indexed write costs two rows**: _"one to the table itself, and one to the index."_ Index deliberately; every index is a write multiplier as well as storage.

At shop-keepr's volume the included allowances are effectively unlimited. The scanned-rows rule matters for _latency_, not for the bill.

### Backups

[d1/reference/time-travel](https://developers.cloudflare.com/d1/reference/time-travel/):

> "Time Travel is D1's approach to backups and point-in-time-recovery, and allows you to restore a database to any minute within the last 30 days."
> "You do not need to enable Time Travel. It is always on."

30 days on Paid, 7 on Free. Minute granularity. 10 restores per 10 minutes per database. No additional cost. D1 also has first-class import/export (`wrangler d1 export`), which Durable Objects lack entirely.

### Architecture note

D1 is itself implemented on SQLite-backed Durable Objects. [Building D1: a Global Database](https://blog.cloudflare.com/building-d1-a-global-database/): Cloudflare ensures _"at most one active copy of the D1 database and routing all HTTP requests to that single database"_, accomplished through Durable Objects, which _"guarantee global uniqueness."_ The storage-options page states it flatly: _"D1 and Queues are built on Durable Objects."_

So "D1 vs DO SQLite" is not a storage-engine comparison. It is a comparison between _the managed product built on that engine_ (schema management, migrations, import/export, Time Travel, read replication, ad-hoc SQL across all data) and _rolling your own on the raw engine_. That framing is what makes D1 the default and DO SQLite the special case.

---

## Candidate 2: Postgres via Hyperdrive

### What it is

A connection pooler and query cache in front of an **existing** Postgres or MySQL database, exposed to a Worker as a binding. Cloudflare's own [storage-options](https://developers.cloudflare.com/workers/platform/storage-options/) positioning: _"Connecting to an existing database in a cloud or on-premise using your existing database drivers & ORMs."_

That framing is the crux. **shop-keepr has no existing database.** Hyperdrive's stated job is to make an existing one usable from Workers, not to be a greenfield default.

Supported surface: Postgres 9.0 → 17.x; auth `md5`, clear-text `password`, `SCRAM-SHA-256`; TLS `require` (default), `verify-ca`, `verify-full`; plain-text connections unsupported.

### Limits

[hyperdrive/platform/limits](https://developers.cloudflare.com/hyperdrive/platform/limits/):

- Configs per account: 25 (Paid) / 10 (Free).
- Origin DB connections per config: ~100 (Paid) / ~20 (Free), minimum 5. **Soft**: _"it is possible for Hyperdrive to make more connections to your database than this limit in the event of network failure to ensure high availability."_ Tunable via `wrangler hyperdrive update <ID> --origin-connection-limit=<N>`.
- Max query duration 60 s. Max cached response 50 MB (larger responses still returned, just not cached). Initial connection timeout 15 s; idle connection timeout 10 min.
- _"Hyperdrive does not limit the number of concurrent client connections from your Workers"_: only origin connections are capped.

### Query caching is a correctness hazard for this app

[hyperdrive/concepts/query-caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/):

- **"Query caching is enabled by default."**
- Defaults: `max_age` = **60 seconds**, `stale_while_revalidate` = **15 seconds**. Maximum configurable `max_age` = 1 hour.
- Only read-only responses are cached; Hyperdrive parses the DB wire protocol rather than keyword-matching to identify mutations.
- Queries using volatile/stable functions are never cached: explicitly `NOW()`, `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME`, `LOCALTIME`, `LOCALTIMESTAMP`, `TIMEOFDAY()`, `RANDOM()`, `LASTVAL()`, `TXID_CURRENT()`. A **SQL comment** containing one of those names is enough to make a query uncacheable.
- **"Hyperdrive does not purge or invalidate cached read query results when your application writes to your database."**

So the default posture is a **60-second stale read-after-write window**. A kiosk could show a card as in stock for up to a minute after staff sold the last copy. The fix is easy once you know (`wrangler hyperdrive create ... --caching-disabled`, or a second config for genuinely cacheable catalogue reads), but it is exactly the class of silent correctness bug an MVP should not have to know about. D1 has no equivalent: it has no read cache with an independent TTL.

**Unverified:** the CLI flags to _tune_ `max_age`/`stale_while_revalidate` rather than disable caching outright were not surfaced on the caching page; cache-key composition is undocumented beyond the comment caveat.

### Latency

[connection-lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/): a direct Worker→Postgres connection costs _"7x round trips"_: TCP handshake (1), TLS negotiation (3), database authentication (3). Hyperdrive terminates the driver handshake _"as close to your Worker as possible… within the same location"_, then makes _"a single round trip across regions to your database"_, reusing a pooled connection near the origin.

Cloudflare's own benchmark (DB in London, queried from Chicago, [blog, 2025-04-08](https://blog.cloudflare.com/how-hyperdrive-speeds-up-database-access/)): direct ≈ **1200 ms**, Hyperdrive ≈ **500 ms**, Hyperdrive + cache ≈ **320 ms**. Client→endpoint handshake p50 2 ms / p90 4 ms. Cached query served from the client's own datacenter ≈ 4 ms. GA-era headline claims 17–25x for cached queries and 6–8x for uncached queries and writes.

Note what those numbers say: even _with_ Hyperdrive, a cross-region uncached query is ~500 ms. Getting good numbers requires the Postgres origin to be near the store, which is a placement decision you now own, and which D1's location hint gives you for free.

The docs contain **no cold/warm distinction** and no first-request-through-Hyperdrive percentiles.

### It does not run under `wrangler dev`

[hyperdrive/configuration/local-development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/): locally the Worker connects **directly** to a database via `localConnectionString` (or `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`). Verbatim:

> "When using `localConnectionString`, Hyperdrive's connection pooling and query caching do not take effect. Your Worker connects directly to the database without going through Hyperdrive."

`wrangler dev --remote` is needed to exercise the real path. So local development runs a materially different data path from production, including _without_ the 60-second cache whose staleness is the main hazard. That is a bad combination: the bug class you most need to catch is the one local dev cannot reproduce.

### Unsupported Postgres features

[supported-databases-and-features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) and [connection-pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/):

- **Unsupported:** SQL-level prepared statement management (`PREPARE`/`EXECUTE`/`DEALLOCATE`/`DISCARD`), **advisory locks**, and **`LISTEN`/`NOTIFY`**.
- **Session state is destroyed between queries:** _"When a connection is returned to the pool, the connection is `RESET` such that the `SET` commands will not take effect on subsequent queries."_ Postgres RLS via `set_config`/`SET LOCAL` therefore only survives inside an explicit transaction, relevant if `storeId` scoping were ever pushed into RLS.
- **Transactions work but are a documented scaling hazard:** _"It is not recommended to wrap multiple database operations with a single transaction to maintain the `SET` state. Doing so will affect the performance and scaling of Hyperdrive, as the connection cannot be reused by other Worker isolates for the duration of the transaction."_ The pool is transaction-mode only; there is no session mode.
- Named prepared statements at the _protocol_ level (as postgres.js and node-postgres use) **are** supported, since 2024-06-28.
- Escape hatch for unsupported statements: _"set up a second, direct client without Hyperdrive."_

The `LISTEN`/`NOTIFY` finding is worth dwelling on, because it removes the most attractive Postgres-specific argument for shop-keepr. "Use Postgres and get change notification for free" does not work through Hyperdrive. Realtime would still need a Durable Object or a third-party service, the same answer as with D1.

**Unverified:** `COPY`, cursors, and extension support are not addressed on any page fetched.

### Cost

Hyperdrive itself is free on **both** plans ([pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), page updated 2026-06-18): _"Hyperdrive's connection pooling and query caching are included in Workers Paid plan, so do not incur any additional charges."_ 100,000 queries/day on Free, unlimited on Paid, no egress charges, and _"All queries (cached or uncached) count identically toward limits."_

But Hyperdrive is not the database. Entry pricing from the providers' own pages:

**Neon** ([neon.com/pricing](https://neon.com/pricing)): Free is $0/mo, 0.5 GB storage/project, 100 CU-hours/project. Permanent, not a trial. Launch is PAYG at $0.106/CU-hour + $0.35/GB-month. Scale-to-zero after 5 minutes, **not disableable on Free**, configurable on paid tiers. Cold start: _"Once you query the database again, it reactivates automatically within a few hundred milliseconds"_ ([scale-to-zero docs](https://neon.com/docs/introduction/scale-to-zero)). That reactivation stacks **on top of** Hyperdrive's path: a warm Hyperdrive pool does not hide a suspended Neon compute.

**Supabase** ([supabase.com/pricing](https://supabase.com/pricing)): Free is $0/mo, 500 MB DB, max 2 active projects, and **"Free projects are paused after 1 week of inactivity"**, a hard pause requiring a restore, not a sub-second wake. Pro is **$25/mo** with 8 GB and no pausing. (Restore duration for a paused project is **unverified**.)

Also note both Cloudflare guides require the **direct, non-pooled** connection string and a standard driver: Neon: _"uncheck the connection pooling checkbox"_ and _"you should use a driver like node-postgres (pg) or Postgres.js… instead of the Neon serverless driver"_; Supabase: _"you should use the Direct connection connection string rather than the pooled connection strings"_, with pg/postgres.js _"instead of the Supabase JavaScript client"_.

So the realistic floor is either a free tier that sleeps (reintroducing the latency Hyperdrive exists to remove) or ~$25/month plus a second vendor's dashboard, credentials, status page and upgrade cadence, for a store whose whole architecture decision was "Cloudflare end-to-end."

### The Nitro problem

[nitrojs/nitro#3893](https://github.com/nitrojs/nitro/issues/3893), open with no maintainer diagnosis: Nitro 3's experimental `useDatabase()` + `db0/integrations/drizzle` over Hyperdrive fails with 500s _"approximately 95% of the time"_, whereas _"manually create the connection using the Hyperdrive connection string directly (bypassing `useDatabase` abstraction)… works 100% of the time."_ There is a working path (bypass `useDatabase`), but this is an unresolved bug in precisely the Nuxt + Hyperdrive + Drizzle combination shop-keepr would be adopting.

Also: `nodejs_compat` is required and Nitro's own Cloudflare docs never mention it; driver minimums are `pg@8.13.0` / `postgres@3.4.4` / Drizzle 0.26.2+; Cloudflare's examples use `compatibility_date` "2026-09-06" and advise bumping anything before 2026-08-04.

### What Postgres would genuinely buy

Real things, none of which shop-keepr needs at MVP:

- Storage beyond 10 GB.
- Interactive transactions (`BEGIN` … application logic … `COMMIT`), though Hyperdrive documents holding one open as a scaling hazard.
- `NUMERIC`/`DECIMAL`, `jsonb` with indexing and operators, native enums with a real DB constraint, arrays, materialized views, `timestamptz`, sequences, RLS, extensions.
- A portable, boring database you could move off Cloudflare entirely.

The `NUMERIC` point deserves a note because shop-keepr handles prices, and it is the single biggest silent-corruption risk in the whole comparison. SQLite has **no exact decimal type**. The correct answer is _store money as integer minor units_ (pence), which is good practice on any engine, is what the schema should do regardless, and keeps the Postgres door open for free. This is a schema-discipline requirement, not a reason to pick Postgres.

---

## Candidate 3: Durable Object SQLite

### Limits

[durable-objects/platform/limits](https://developers.cloudflare.com/durable-objects/platform/limits/):

| Limit                         | Workers Paid                                          | Workers Free |
| ----------------------------- | ----------------------------------------------------- | ------------ |
| Storage per Durable Object    | **10 GB**                                             | 1 GB         |
| Storage per account           | Unlimited                                             | 5 GB         |
| Number of objects             | Unlimited                                             | n/a          |
| DO classes per account        | 500                                                   | 100          |
| CPU per request               | 30 s default, configurable to 5 min (`limits.cpu_ms`) | n/a          |
| Request throughput per object | soft limit ~1,000 req/s                               | n/a          |
| Columns per table             | 100                                                   | n/a          |
| Bound parameters per query    | 100                                                   | n/a          |
| Max string / BLOB / row size  | 2 MB                                                  | n/a          |
| Max SQL statement length      | 100 KB                                                | n/a          |
| Alarm handler wall time       | 15 minutes                                            | n/a          |

**The 10 GB per object is identical to D1's 10 GB per database.** Choosing DO SQLite as the primary store does not raise the ceiling. The ceiling only rises if you shard across many objects, and sharding is precisely what breaks cross-SKU search.

Full-disk behaviour: writes fail with `database or disk is full: SQLITE_FULL`; _"Read operations … will continue to work, and DELETE operations will also succeed."_

**Not documented anywhere** (verified by grepping the full 736 KB DO docs corpus): SQL query timeout, WAL size limit, per-statement time limit. The only timeout figures that exist are the 30 s `blockConcurrencyWhile` callback limit (exceeding it resets the object) and an unnumbered _"Durable Object storage operation exceeded timeout"_ error. Do not let anyone assert a DO SQL query timeout number.

### Status and migrations

SQLite storage went **GA on 2025-04-07** ([changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)) and is now effectively mandatory: since **2026-07-09**, accounts with no pre-existing KV-backed namespace [cannot create one](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/): _"Creating new key-value backed Durable Object namespaces is no longer supported on this account. Please create a namespace using a `new_sqlite_classes` migration instead."_ Workers Free is SQLite-only.

`new_classes` = legacy KV backend; `new_sqlite_classes` = SQLite. _"Only Durable Object classes with a SQLite storage backend can access SQL API."_ There is **no in-place KV→SQLite migration**: _"a migration path from the key-value storage backend to the SQLite storage backend will be available in the future."_ Moot for greenfield (shop-keepr would start on `new_sqlite_classes`), but worth knowing that storage backends cannot be changed later.

### Backups

Point-in-time recovery exists and matches D1's window ([sqlite-storage-api](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)): _"restore a Durable Object's embedded SQLite database to any point in time in the past 30 days … The PITR API is not supported in local development because a durable log of data changes is not stored locally."_ API: `getCurrentBookmark()`, `getBookmarkForTime(timestamp)` (must be within 30 days), `onNextSessionRestoreBookmark(bookmark)` then `ctx.abort()` to complete recovery, returning an undo bookmark.

Two differences from D1 that matter operationally: this is a **code-invoked, per-object** recovery, not a console restore; and there is **no export/backup primitive at all**: D1 has `wrangler d1 export` / import, Durable Objects have nothing equivalent.

### Why it is wrong as the primary store here

1. **No cross-object query. At all.** This is a hard negative, verified by grepping the entire DO docs corpus (736,517 bytes) for "query across", "across durable objects", "fan-out", "global query", "cross-object", "enumerate", "list all". There is no production API to query, or even _enumerate_, the objects in a namespace. The only "list all IDs" function is `listDurableObjectIds()` from `cloudflare:test`, a Vitest harness helper unavailable in a deployed Worker. Official guidance is manual sharding plus fan-out you write yourself: _"If your use case exceeds these limits, shard your workload across multiple Durable Objects"_, plus the [control-plane / data-plane pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/) where a coordinator DO holds an index and children hold data. **Kiosk search is inherently cross-SKU.** You would be hand-writing a scatter-gather query engine plus a separate search index plus a consistency story between them.
2. **No DO read replicas.** Same corpus grep for "replica" returned exactly one hit: a cross-link to D1's read replication. Read replication is D1-only. The D1 read-replication blog describes replica Durable Objects, but that is D1's _internal implementation_, not a user-facing DO capability. Anyone planning around DO read replicas is mistaken.
3. **Single object = serialised application logic.** A Durable Object processes requests serially. One object holding the whole store's inventory queues every kiosk search, staff page load and buy-in behind the same thread. Note the honest version of this: D1 is _also_ one Durable Object, so the raw storage engine is equally serial. The difference is that D1's object runs query execution only, whereas a hand-rolled DO also runs your application logic inside that same serial budget, and D1 has read replication as a documented escape valve while DOs have none. Compounding it: the Drizzle DO pattern runs `migrate()` inside `ctx.blockConcurrencyWhile()` in the constructor, and Cloudflare warns `blockConcurrencyWhile` _"significantly reduces throughput… If each call takes ~5ms, that individual Durable Object is limited to approximately 200 requests/second."_
4. **You give up the managed surface.** No `wrangler d1 migrations apply`, no import/export, no external HTTP query API, no dashboard console, no read replication, no location hint.
5. **Cloudflare's own guidance says so.** [storage-options](https://developers.cloudflare.com/workers/platform/storage-options/), verbatim:

   > "D1 for lightweight, serverless applications that are read-heavy, have global users that benefit from D1's read replication, and do not require you to manage and maintain a traditional RDBMS."
   > "Durable Objects for stateful serverless workloads, per-user or per-customer SQL state, and building distributed systems … where Durable Object's strict serializability enables global ordering of requests and storage operations."

   And decisively for this ticket: D1 is recommended for _"use-cases that require querying across your data ad-hoc (using SQL)"_. Cloudflare's own answer to problem (1) is "then use D1."

### Pricing

[durable-objects/platform/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): requests $0.15/M after 1M/mo; **duration $12.50/M GB-s after 400,000 GB-s/mo**; SQLite rows read $0.001/M after 25B/mo; rows written $1.00/M after 50M/mo; SQL stored data $0.20/GB-month after 5 GB-month. SQLite storage billing went live 2026-01-07. Incoming WebSocket messages bill at a 20:1 ratio for request counting.

Note the structural difference: **Durable Objects charge duration (GB-s) on top of row costs; D1 does not.** A long-lived, frequently-woken object accrues wall-clock charges. At shop-keepr's scale this stays inside the free allowance, but it is a cost axis to keep in mind for #4 if a hold-coordination DO is kept warm.

DO SQLite is not rejected outright: it is assigned to the job it is good at. See the next section.

---

## Where Hold state lives (boundary with #4)

This ticket does not resolve [#4](https://github.com/KeeprDigital/shop-keepr/issues/4). It resolves the _boundary_, which is this ticket's business:

> **Holds are rows in D1, with an `expires_at` column. The Durable Object is the timer and the fanout, not a second source of truth.**

Rationale:

- **Available-to-promise stays one SQL query.** Kiosk search already reads D1 for the SKU and its on-hand. If active Holds are D1 rows, ATP is `on_hand − SUM(hold.quantity) WHERE expires_at > now()`: one query, one store, no distributed join, no RPC to a Durable Object on the search hot path. If Holds lived in DO storage instead, this read would need both stores and a merge, and (because there is no cross-DO query) could not be expressed as SQL at all if holds were ever sharded.
- **Correctness does not depend on the alarm firing on time.** Because the query filters on `expires_at > now()`, an expired Hold stops counting against ATP the instant it expires, whether or not any timer has run. The alarm's job is to _notify_ the kiosk and staff UI and to tidy rows, not to make the numbers right. DO alarms give at-least-once delivery with exponential backoff (2 s initial, up to 6 retries), wake a hibernated object, and get a 15-minute handler wall-time budget ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)), comfortably good enough for notification, and now you do not have to care if one is late.
- **No dual-write authority split.** If a DO owned live Holds in its own SQLite while D1 owned Movements, every ATP read would need both, and every reconciliation bug would be a phantom-stock bug in front of a customer. One store, one truth.
- **One alarm per object.** _"Each Durable Object can have a single alarm at a time."_ A store-scoped hold-expiry DO therefore keeps pending expiries in storage and sets its alarm to the earliest. A standard pattern, but worth knowing before #4 designs around one alarm per Hold.
- **Also note:** `LISTEN`/`NOTIFY` is unsupported through Hyperdrive, so choosing Postgres would not have avoided needing a Durable Object (or Ably) for realtime anyway. The realtime mechanism is orthogonal to the store choice.

Left open for #4: whether the DO is per-store or per-Basket; whether it holds WebSocket connections directly (hibernatable WebSockets, billed 20:1) or fans out another way; whether it keeps a scheduling cache of pending expiries in its own SQLite. All of those are compatible with D1 as the source of truth.

---

## Aggregating the ledger

The same answer in all three candidates, so it does not discriminate between them, but it is the design decision the ticket is really asking about.

**Do not `SUM` the ledger on the read path.** Maintain a derived on-hand alongside the Inventory Item and update it in the same atomic `batch()` that appends the Movement:

```
batch([
  INSERT INTO movement (...) VALUES (...),
  UPDATE inventory_item SET on_hand = on_hand + ?, updated_at = ? WHERE id = ? AND store_id = ?
])
```

Properties:

- The ledger stays authoritative and append-only. The derived column is a **cache**, rebuildable at any time by `SELECT inventory_item_id, SUM(delta) FROM movement GROUP BY inventory_item_id`. Keep that rebuild as a maintenance script _and_ as a test assertion (`derived == recomputed`) from day one. That assertion is what catches projection bugs before a customer does.
- Kiosk search becomes an indexed read on `inventory_item`, not a scan of `movement`. Under D1's scanned-rows accounting this is the difference between reading a handful of rows and reading the whole ledger.
- D1's atomic `batch()` gives exactly the atomicity this needs; no interactive transaction required.
- Index `movement(store_id, inventory_item_id, created_at)` for the rebuild and for per-SKU history views. Remember each index doubles the row-write cost.
- Use a **plain column**, not a `STORED` generated column: D1 cannot add a `STORED` column to an existing table via `ALTER TABLE`, so a generated rollup would require a table rebuild to introduce later.

The alternative, aggregating on read with a covering index, is viable at MVP volume and simpler to get right. It is a reasonable _first_ implementation if the projection feels premature; the ledger schema is identical either way, so switching later is purely additive (add a column, backfill, change one query). Say so explicitly in the spec, so a build session does not treat the projection as load-bearing before it needs to be.

---

## Drizzle across the three

|                    | D1                                                      | DO SQLite                                                                                                | Postgres via Hyperdrive                        |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Import             | `drizzle-orm/d1`                                        | `drizzle-orm/durable-sqlite`                                                                             | `drizzle-orm/postgres-js` or `node-postgres`   |
| Schema             | `drizzle-orm/sqlite-core`                               | `drizzle-orm/sqlite-core`                                                                                | `drizzle-orm/pg-core`                          |
| Sync/async dialect | `async`                                                 | **`sync`**                                                                                               | `async`                                        |
| `db.batch()`       | **Yes**                                                 | **No**                                                                                                   | Neon HTTP driver only                          |
| Config             | `dialect: 'sqlite'`, `driver: 'd1-http'`                | `dialect: 'sqlite'`, `driver: 'durable-sqlite'`                                                          | `dialect: 'postgresql'`                        |
| Migrations         | `drizzle-kit generate` → `wrangler d1 migrations apply` | `drizzle-kit generate` → `migrate(db, migrations)` in the DO constructor under `blockConcurrencyWhile()` | `drizzle-kit generate` → `drizzle-kit migrate` |

Sources: [connect-cloudflare-d1](https://orm.drizzle.team/docs/connect-cloudflare-d1), [connect-cloudflare-do](https://orm.drizzle.team/docs/connect-cloudflare-do), [sqlite/batch-api](https://orm.drizzle.team/docs/sqlite/batch-api) (which lists libSQL and Cloudflare D1 as the SQLite-family batch drivers).

D1 setup is `const db = drizzle(env.DB)` against a `d1_databases` binding, with `migrations_dir` pointed at the Drizzle output so `wrangler d1 migrations apply` picks up generated SQL.

Three Drizzle caveats worth recording:

1. **Drizzle v1 is still RC.** Both Cloudflare connect pages instruct `npm i drizzle-orm@rc`. Treat the API surface as not final and pin exactly.
2. **`driver: 'durable-sqlite'` and `driver: 'd1-http'` exist but are undocumented** on the `drizzle.config.ts` reference page (which lists only `aws-data-api` and `pglite`). Verified in drizzle-kit source (`src/cli/validations/common.ts`).
3. **The `durable-sqlite` migrator has a real defect** (read from `drizzle-orm` `main`, `src/durable-sqlite/migrator.ts`): it creates `__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`. `SERIAL` is a Postgres type copy-pasted in, the `INSERT` never supplies `id`, and it writes `hash: ''` hardcoded. Applied-migration detection therefore relies solely on `created_at` ordering, never on hashes: editing an applied migration is silently ignored, and out-of-order or backdated migrations get skipped. **Unverified** whether a newer tag or open issue fixes this. Another reason not to make DO SQLite the primary store.

### Portability of the Drizzle code

Drizzle is explicitly **not** a portability layer: _"We embrace SQL dialects and dialect specific drivers and syntax."_ Realistically: query and business logic port ~80–90%; schema definitions and migration history port ~0%.

**Ports cleanly:** `select`/`insert`/`update`/`delete`, where operators, joins, aliases, subqueries, set operations, the `sql` template, relational queries (`db.query.*`), prepared statements with `sql.placeholder`, the transaction API shape, `$inferSelect`/`$inferInsert`, `$defaultFn`/`$default`/`$onUpdateFn` (pure runtime JS, dialect-independent), `returning()` (SQLite supports it), `onConflictDoNothing`/`onConflictDoUpdate`, partial indexes, and `.generatedAlwaysAs()`.

**Breaks** (Postgres → SQLite reality; see [pg column types](https://orm.drizzle.team/docs/column-types/pg) vs [sqlite column types](https://orm.drizzle.team/docs/column-types/sqlite)):

| Postgres                                            | SQLite reality                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `uuid().defaultRandom()`                            | none. Use `text()` + `$defaultFn(() => crypto.randomUUID())`                                                      |
| `jsonb` (indexable, operators)                      | `text({ mode: 'json' })`; no JSONB indexing or operators                                                          |
| `numeric`/`decimal` (exact)                         | **no exact decimal type**. Money must be integer minor units                                                      |
| `timestamptz`, `interval`                           | `integer({ mode: 'timestamp' \| 'timestamp_ms' })`; no timezone, second resolution unless you pick `timestamp_ms` |
| `serial`, `generatedAlwaysAsIdentity()`, sequences  | `integer().primaryKey({ autoIncrement: true })` only                                                              |
| `pgEnum(...)`                                       | `text({ enum: [...] })`, TypeScript-level only, **no DB constraint**                                              |
| arrays (`.array()`)                                 | none                                                                                                              |
| `boolean`                                           | `integer({ mode: 'boolean' })` storing 0/1                                                                        |
| `bigint`                                            | `blob({ mode: 'bigint' })`                                                                                        |
| `inet`/`cidr`, PostGIS, `pgSchema`, RLS, extensions | none                                                                                                              |

Plus: the 100-bound-parameter and 100-column caps have no Postgres analogue and will bite on bulk inserts; drizzle-kit emits dialect-specific migration SQL so history does not port; and SQLite's `ALTER TABLE` limitations mean drizzle-kit recreates tables for many changes.

**Practical guidance:** keep schema definitions in one module, money as **integer minor units**, timestamps as **epoch-ms integers**, IDs as `text` UUIDs generated in app code, no SQLite-only tricks. Then a Postgres port is a day of mechanical work plus a data migration, not a redesign.

---

## Migration cost of choosing wrong

| From → to                    | Cost                                            | Notes                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1 → Postgres/Hyperdrive** | Moderate, bounded                               | `wrangler d1 export` produces SQL; schema rewrite `sqlite-core` → `pg-core` per the table above; provision provider + Hyperdrive config; swap driver. Data volume is trivially small, so a maintenance-window cutover is realistic. This is the migration you would actually do, and it is a known quantity. |
| **D1 → DO SQLite**           | Low-moderate mechanically, high architecturally | Same SQL dialect and same `sqlite-core` schema, but **not a drop-in driver swap**: `durable-sqlite` is a _sync_ dialect (D1 is async) and has **no `batch()`**, so every call site changes. The real cost is architectural: routing, sharding, hand-rolled fan-out, migrations-on-construct, no export.      |
| **DO SQLite → D1**           | Low-moderate                                    | Same dialect; you would be un-sharding and consolidating, which is easier than the reverse, but still a sync→async rewrite of call sites.                                                                                                                                                                    |
| **Postgres → D1**            | High                                            | Feature loss, not feature gain: decimals, enums, `jsonb`, arrays, `timestamptz`, interactive transactions, views. You would be removing capability the code had come to rely on.                                                                                                                             |

The asymmetry is the argument. Starting at D1 keeps the one migration you might plausibly need (→ Postgres) bounded and mechanical. Starting at Postgres closes the cheap direction. Starting at DO SQLite pays architectural cost immediately for a ceiling identical to D1's.

---

## Platform integration notes

- **Nitro presets.** `cloudflare_module` is the default/recommended Workers preset; `cloudflare_durable` adds Durable Objects support; `cloudflare_pages` is legacy. Set via `nitro.preset` in `nuxt.config.ts` ([nitro.build/deploy/providers/cloudflare](https://nitro.build/deploy/providers/cloudflare)).
- **Bindings.** _"At runtime, you can access bindings from the request event via `event.req.runtime.cloudflare.env`."_ Nitro also advises preferring its high-level KV/Database abstractions over low-level platform APIs; **ignore that advice here.** The portability Nitro is protecting is not portability we want, Drizzle is the abstraction layer that matters, and Nitro's `useDatabase()` abstraction is exactly what is broken over Hyperdrive in [nitro#3893](https://github.com/nitrojs/nitro/issues/3893).
- **Durable Objects from Nitro.** Supported via `cloudflare_durable`: an `exports.cloudflare.ts` at the project root exports additional handlers from the Worker entrypoint, with `cloudflare:durable:init` / `cloudflare:durable:alarm` runtime hooks and a `$DurableObject` class registered in `wrangler.jsonc`. Relevant to #4; noted here so the data-layer choice does not need revisiting when the DO lands.
- **`nitro-cloudflare-dev` is deprecated**: _"This module is no longer required for the latest versions of Nitro"_ ([repo](https://github.com/nitrojs/nitro-cloudflare-dev)). Do not add it.
- **Current repo state.** `nuxt.config.ts` has no `nitro.preset` and there is no `wrangler.jsonc`. The decision is fully greenfield; nothing has to be undone.

---

## Checklist for the build session

1. `nitro.preset: 'cloudflare_module'` (→ `cloudflare_durable` once #4 lands). Add `wrangler.jsonc` with a `d1_databases` binding named `DB` and `migrations_dir` pointing at the Drizzle output.
2. **Create the database with an explicit `--location` hint** matching the store's region. It cannot be changed later without recreating the database.
3. Run on **Workers Paid**; Free-plan D1 row limits are hard-enforced since 2026-09-01.
4. Drizzle with `sqlite-core`, pinned (`drizzle-orm@rc`; v1 is not final). One schema module.
5. `storeId` (text) on every table, as the leading column of every composite index.
6. Money as **integer minor units**. Timestamps as **epoch-ms integers**. IDs as `text` UUIDs generated in app code. No SQLite-only cleverness; this is what keeps the Postgres exit cheap.
7. `movement` is append-only: no `UPDATE`/`DELETE` paths in application code. Corrections are new Movements. Carry an idempotency key, because **D1 does not auto-retry writes**.
8. Derived `on_hand` on `inventory_item` as a **plain column** (not `STORED` generated), written in the same `batch()` as the Movement insert. Ship a rebuild-from-ledger script and a test asserting `derived == recomputed`.
9. Holds as D1 rows with `expires_at`; ATP filters on `expires_at > now()`. Do not make correctness depend on the expiry alarm.
10. Mind the **100 bound parameters per statement** limit (it applies inside batches too) on any bulk kiosk-search lookup; chunk it.
11. Consider **FTS5** for kiosk card-name search rather than leading-wildcard `LIKE`, which the D1 docs list as an anti-pattern. Note FTS virtual tables are excluded from `wrangler d1 export` and must be rebuilt after a restore.
12. Use `db.withSession()` from the start even with replication off; it costs nothing and forecloses a read-your-writes bug later.

---

### Cross-check against #3 (auth)

The auth research on [#3](https://github.com/KeeprDigital/shop-keepr/issues/3) (branch `research/auth-workers`, `docs/research/2026-09-07-auth-on-cloudflare-workers.md`) recommends self-hosted Better Auth, and reports that auth does not constrain this decision. Three points that bear on the data layer:

- **D1 is the best-supported target for auth too.** Better Auth 1.5 takes `database: env.DB` directly, so auth tables can live in the same D1. Under Hyperdrive it should work via the Kysely dialect and a `pg` Pool, but there are no published examples, so it would need a spike. Durable Object SQLite cannot host auth tables at all (`ctx.storage.sql` is DO-internal), though that would not block anything: auth would simply get its own small D1 alongside. So DO SQLite should be ruled out on the grounds in this document, not on the belief that it forces an auth rewrite.
- **Workers Paid is independently a hard requirement** (the Free plan's 10 ms CPU per request cannot fit scrypt password hashing). That removes any lingering reason to reason about D1's Free-tier row caps.
- **A live Drizzle-on-D1 maturity signal:** Better Auth's Drizzle adapter is reported broken on D1 ([better-auth#10816](https://github.com/better-auth/better-auth/issues/10816)) because it never sets `supportsDates`, so a raw `Date` reaches D1 and throws `D1_TYPE_ERROR: Type 'object' not supported`. **Unverified** here, but it is the same D1 constraint that the epoch-ms-integer timestamp discipline in the checklist above exists to avoid: never hand D1 a `Date` object. Worth carrying into the build session as a convention, not just a portability nicety.

  Scope note, from #3: this convention applies to the **application schema only**. Better Auth's built-in Kysely/D1 path reportedly sets `supportsDates: false` and serialises internally, so the auth tables already handle it and do not need the rule restated over them. The two documents therefore do not impose overlapping rules on the same tables.

---

## Sources

Cloudflare (primary):

- [Choosing a data or storage product](https://developers.cloudflare.com/workers/platform/storage-options/)
- [D1; Limits](https://developers.cloudflare.com/d1/platform/limits/) · [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Worker Binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) · [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) · [Data location](https://developers.cloudflare.com/d1/configuration/data-location/) · [Use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) · [Query JSON / generated columns](https://developers.cloudflare.com/d1/sql-api/query-json/) · [SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) · [Foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) · [Import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) · [Changelog](https://developers.cloudflare.com/changelog/rss/d1.xml)
- [Building D1: a Global Database (blog)](https://blog.cloudflare.com/building-d1-a-global-database/)
- [Hyperdrive; Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) · [Limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) · [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) · [Connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/) · [Connection pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/) · [Supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) · [Local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/) · [Connect to Postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [How Hyperdrive speeds up database access (blog)](https://blog.cloudflare.com/how-hyperdrive-speeds-up-database-access/)
- [Durable Objects; Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) · [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) · [Access DO storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) · [SQLite GA changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/) · [KV namespace restriction changelog](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/) · [Control-plane / data-plane pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- [workerd `MODULE.bazel` (SQLite version)](https://raw.githubusercontent.com/cloudflare/workerd/main/MODULE.bazel)

Drizzle (primary):

- [Cloudflare D1](https://orm.drizzle.team/docs/connect-cloudflare-d1) · [Cloudflare Durable Objects](https://orm.drizzle.team/docs/connect-cloudflare-do) · [SQLite batch API](https://orm.drizzle.team/docs/sqlite/batch-api) · [PG column types](https://orm.drizzle.team/docs/column-types/pg) · [SQLite column types](https://orm.drizzle.team/docs/column-types/sqlite) · [drizzle.config.ts](https://orm.drizzle.team/docs/drizzle-config-file)

Nitro / Nuxt (primary):

- [Cloudflare deployment provider](https://nitro.build/deploy/providers/cloudflare) · [nitro#3893 (Hyperdrive + useDatabase bug)](https://github.com/nitrojs/nitro/issues/3893) · [nitro-cloudflare-dev (deprecated)](https://github.com/nitrojs/nitro-cloudflare-dev)

Providers (primary):

- [Neon pricing](https://neon.com/pricing) · [Neon scale-to-zero](https://neon.com/docs/introduction/scale-to-zero) · [Supabase pricing](https://supabase.com/pricing)
