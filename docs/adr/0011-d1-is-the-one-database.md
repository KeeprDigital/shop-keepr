---
status: accepted
---

# D1 is the one database, for stock and for search

shop-keepr keeps every table — ledger, SKUs, Holds, Baskets, settings, auth, and the whole Catalogue Mirror with its search structures — in a single Cloudflare D1 database, accessed through Drizzle. Decided in [#2](https://github.com/KeeprDigital/shop-keepr/issues/2), re-examined and confirmed on different reasoning in [#20](https://github.com/KeeprDigital/shop-keepr/issues/20) after [#18](https://github.com/KeeprDigital/shop-keepr/issues/18) and [#19](https://github.com/KeeprDigital/shop-keepr/issues/19), and extended to search by [#24](https://github.com/KeeprDigital/shop-keepr/issues/24).

The surprise this records: **the Mirror and the store's stock must live in one physical database, permanently.** A filtered, sorted, paginated query ("blue commons we have in stock, cheapest first, page 3") only computes against one index holding every field it filters or sorts on, and D1 forbids cross-database access outright (`ATTACH`, temp tables and temp views all refuse). A second database or a remote search index would make stock advisory or cap results at top-N.

## Considered options

**Postgres via Hyperdrive** — rejected on three footguns independent of latency: Hyperdrive's query cache is on by default with no write invalidation, it does not run under `wrangler dev`, and there is no `LISTEN`/`NOTIFY`; the only Worker-clean path (HTTP drivers) offers exactly D1's transaction model ([#19](https://github.com/KeeprDigital/shop-keepr/issues/19)).

**libSQL / Turso** — rejected: the engine Turso recommends for new projects has no FTS5; embedded replicas cannot run on Workers; its interactive transactions produced 960 `SQLITE_BUSY` errors in the reservation race where D1 produced zero ([#18](https://github.com/KeeprDigital/shop-keepr/issues/18)).

**Durable Object SQLite as the primary store** — rejected: the same 10 GB ceiling with no cross-object query ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2)).

**A hosted search engine** (Orama in-Worker, Algolia, Typesense) — rejected: Orama's index exceeds the isolate heap; a remote index returns top-N, which loses exact name-plus-facet pagination against stock ([#25](https://github.com/KeeprDigital/shop-keepr/issues/25), [#16](https://github.com/KeeprDigital/shop-keepr/issues/16)).

## Consequences

**`batch()` is atomic but not conditional.** D1 has no interactive transactions. A statement that depends on an earlier conditional statement runs even when that statement changed nothing, so every dependent write carries its own `AND EXISTS (…)` guard in SQL and checks `meta.changes`. This is a standing discipline for every multi-row write ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).

**Whole-database export is lost.** An FTS5 table makes `wrangler d1 export` fail for the entire database. Backups are per-table exports, Time Travel (30 days), and a scheduled dump of the ledger tables to R2; the Mirror is a re-seed, never a backup ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).

**Measured caps shape every write**: 100 bound parameters and 100,000 bytes per statement, five members per compound `SELECT`, a ~20 ms floor per statement from a Worker. Bulk writes inline escaped literals; multi-select facets use `IN`, never `UNION`; dependent reads go in one `batch()` ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).

**Revisit triggers**: the 10 GB ceiling in view; a second store needing cross-store reporting; a write that must read, decide and write and cannot be expressed as one statement; the denormalisation tax spreading beyond the Mirror ([#20](https://github.com/KeeprDigital/shop-keepr/issues/20)).
