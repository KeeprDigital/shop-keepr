# Research: D1 search capabilities for the Catalogue mirror

- **Issue:** [#13](https://github.com/KeeprDigital/shop-keepr/issues/13) (parent decision [#6](https://github.com/KeeprDigital/shop-keepr/issues/6), map [#1](https://github.com/KeeprDigital/shop-keepr/issues/1))
- **Date:** 2026-09-07
- **Status:** resolved
- **Builds on:** [`2026-09-07-cloudflare-data-layer.md`](./2026-09-07-cloudflare-data-layer.md) (the closed D1 decision on [#2](https://github.com/KeeprDigital/shop-keepr/issues/2))
- **Spike:** [`spike/d1-search/`](../../spike/d1-search/). Every measured number below comes from it.

Issue #6 committed to mirroring the whole Catalogue into D1 and serving faceted storefront search locally, on three claims it recorded as **asserted from knowledge, not verified**. This document verifies them. Documentation claims were fetched live from primary sources on 2026-09-07; measurements were taken on local workerd/miniflare the same day. Where measurement and documentation conflict, the measurement is reported and the conflict is named. Anything that could not be settled is marked **unverified**.

---

## Verdict

**All three claims hold. #6's architecture survives. Two of its numbers and one of its design sentences do not.**

| #6 claim                                             | Verdict                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| FTS5 available on D1 for name search over ~150k rows | **Confirmed, and more capable than #6 assumed.** 1 to 6 ms, 39 rows read.                                                                |
| D1 has no cross-database joins                       | **Confirmed, and permanent.** Not merely absent: actively refused by the authorizer.                                                     |
| Index behaviour and row-read limits at ~150k rows    | **Confirmed for the common case.** One bad tail, quantified below.                                                                       |
| ~60 MB mirror at ~400 bytes/row                      | **Both numbers wrong.** 236 bytes/row measured; the _searchable_ mirror is ~96 MB.                                                       |
| "Stock is a separate table … joined at query time"   | **Holds at one store's volume; degrades badly at 10x.** See [The bad tail](#the-bad-tail-a-selective-facet-reads-the-whole-stock-table). |

Nothing found here justifies reopening #6. The conclusion (mirror the whole Catalogue, one database, one local faceted query) is sound, and the measurements are more favourable than #6's own estimates in every dimension except one.

---

## Claim 1: FTS5 on D1

### What the documentation says

Cloudflare's [SQL statements page](https://developers.cloudflare.com/d1/sql-api/sql-statements/) (last updated 2026-04-21) devotes exactly one sentence to it:

> "D1 supports a subset of SQLite extensions for added functionality, including: **FTS5 module** for full-text search (including `fts5vocab`)."

That is the entire treatment. **Across all 52 pages of the D1 documentation tree, FTS5 is mentioned three times**: that bullet, an export limitation quoted [below](#the-operational-cost-fts5-makes-the-database-non-exportable), and one cell in the [use-indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) anti-pattern table. There is **no** documented syntax, **no** example, **no** list of supported tokenizers, and **no** mention of `MATCH`, `bm25()`, `snippet()` or `highlight()` anywhere. Cloudflare also does not document D1's SQLite version, and D1 refuses to tell you: `SELECT sqlite_version()` returns `not authorized to use function: sqlite_version: SQLITE_ERROR`.

The one place Cloudflare names a tokenizer, it does so by hyperlink to sqlite.org rather than as a statement about D1's own build, in the use-indexes anti-pattern for leading-wildcard `LIKE`:

> "For arbitrary substring searches, consider FTS5 with the trigram tokenizer, which can optimize patterns containing at least three consecutive non-wildcard Unicode characters. FTS5 indexes increase storage and write costs, so benchmark them for your workload."

So the documentation asserts FTS5 exists and recommends a tokenizer it never confirms is present. Everything below the word "FTS5" had to be measured.

### What is actually there

Measured (`spike/d1-search/capabilities.test.ts`). Everything in this table was probed by creating the object and using it, not by reading a manifest.

| Feature                                            | Result                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `CREATE VIRTUAL TABLE … USING fts5(…)`             | works                                                                            |
| `tokenize='unicode61'` (default)                   | works                                                                            |
| `tokenize='ascii'`                                 | works                                                                            |
| `tokenize='porter'`                                | works                                                                            |
| `tokenize='trigram'`                               | works                                                                            |
| `tokenize='porter unicode61'` (wrapper form)       | works                                                                            |
| `tokenize='trigram case_sensitive 0'`              | works                                                                            |
| `prefix='2 3'`                                     | works                                                                            |
| `content=''` (contentless)                         | works                                                                            |
| `content='', contentless_delete=1`                 | works                                                                            |
| `columnsize=0`                                     | works                                                                            |
| `content='base_table', content_rowid='id'`         | works                                                                            |
| `CREATE TRIGGER` to sync an external-content index | works, and the synced row matched                                                |
| `bm25()`, `rank`, `snippet()`, `highlight()`       | all work                                                                         |
| prefix query `sent*`, phrase query `"of the deep"` | both work                                                                        |
| `fts5vocab(ft, 'row')`, two-argument form          | works                                                                            |
| `fts5vocab` three-argument form                    | **impossible**. It requires a `temp.` database, and D1 refuses all temp objects. |
| `fts4`, `fts3`, `dbstat`, `csv` virtual tables     | refused, `SQLITE_AUTH`                                                           |
| `rtree`                                            | allowed (failed only on column count)                                            |

`contentless_delete=1` requires SQLite 3.43.0 or later, and `trigram` requires 3.34.0 or later ([SQLite changelog](https://www.sqlite.org/changes.html)). Both work, so D1's engine is at least 3.43.0. `workerd`'s [`MODULE.bazel`](https://raw.githubusercontent.com/cloudflare/workerd/main/MODULE.bazel) pins `sqlite-src-3530400` (3.53.4) plus six Cloudflare patches, which is strongly indicative but **unverified** for D1's production backend. Since the version is undocumented, Cloudflare has made no commitment to it.

### Name search at 150k rows, measured

150,000 Catalogue rows, 4,000 stock rows, one D1 database.

| Query                                                   | Median | `rows_read` |
| ------------------------------------------------------- | -----: | ----------: |
| FTS5 single token (`sentinel`)                          |   4 ms |          39 |
| FTS5 two tokens (`thundering sentinel`)                 |   1 ms |          39 |
| FTS5 prefix token (`sent*`)                             |   5 ms |          39 |
| FTS5 phrase (`"sentinel of storms"`)                    |   2 ms |          39 |
| FTS5 + game facet + join to stock, price-sorted         |   6 ms |      20,194 |
| Trigram `MATCH` substring (`entine`)                    |  <1 ms |          19 |
| Trigram indexed `LIKE '%entine%'`                       |  <1 ms |          19 |
| `LIKE 'Thundering Sent%'`, bound parameter              |  92 ms |     110,119 |
| `LIKE '%Sentinel%'`, bound parameter                    |  92 ms |     113,659 |
| `LIKE 'Thundering Sent%'` with a `COLLATE NOCASE` index |  <1 ms |         238 |

Three things in that table matter more than the headline.

**A parameterised prefix `LIKE` does not use an index.** `EXPLAIN QUERY PLAN` for `WHERE game_system = ?1 AND name LIKE ?2` with `?2 = 'Thundering Sent%'` gave `SEARCH catalogue_printing USING INDEX cp_game_set (game_system=?)` followed by `USE TEMP B-TREE FOR ORDER BY`: 110,119 rows read for 20 results. The cause is SQLite's LIKE optimisation requiring the index collation to match `LIKE`'s case-folding, and a default `BINARY` index cannot serve the default case-insensitive `LIKE`. Adding `CREATE INDEX cp_name_nocase ON catalogue_printing (game_system, name COLLATE NOCASE)` changed the plan to `SEARCH … USING INDEX cp_name_nocase (game_system=? AND name>? AND name<?)` and the cost to 238 rows read. **This is the single most dangerous result in this document.** A naive prefix search looks correct, passes tests, and is the slowest query in the application. The `PRAGMA case_sensitive_like = on` escape also works (sent in the same `.batch()` as the query, it changed the plan to use `cp_name`), but D1 documents that _"D1 PRAGMA statements only apply to the current transaction"_, so it would have to be prepended to every batch. The `COLLATE NOCASE` index is the better answer.

**Trigram FTS5 is the answer to mid-name substring search**, which is what a staff member typing part of a card name actually does. `LIKE '%entine%'` against a trigram index read 19 rows; the same `LIKE` against the base table read 113,659. Cloudflare's recommendation is correct and now verified on D1.

**An external-content FTS5 index does not follow its base table.** Measured directly: renaming a row in `catalogue_printing` left the FTS index still matching the _old_ name and not matching the new one. The base table and the index diverged silently, with no error. SQLite is explicit that this is the caller's problem: _"it is the responsibility of the user to ensure that the contents of the full-text index are consistent with the named database object. If they are not, query results may be unpredictable."_ The repair (a `'delete'` command row, then a reinsert) cost 1 `rows_written` each and 3 ms. Triggers work on D1 and are SQLite's recommended sync mechanism.

### The operational cost: FTS5 makes the database non-exportable

Verbatim, from [import-export-data](https://developers.cloudflare.com/d1/best-practices/import-export-data/):

> "**Export is not supported for virtual tables, including databases with virtual tables.** D1 supports virtual tables for full-text search using SQLite's FTS5 module. As a workaround, delete any virtual tables, export, and then recreate virtual tables."

Note the scope: not the table, **the database**. The moment a search index exists, `wrangler d1 export` stops working for everything in it. Time Travel (30 days, minute granularity) is unaffected, and #6's "the mirror is a re-seed, not a migration" reasoning means this costs little in practice. But it removes the ordinary backup and database-copy path from a database that also holds the ledger, and that is a fact about the _whole_ co-located design, not about search.

### Corpus caveat on the size figures

The generated corpus holds **534 distinct FTS5 terms over 1,338,766 instances** across 150,000 rows. A real trading-card catalogue's vocabulary is one to two orders of magnitude larger. FTS5 index size is driven mostly by postings volume (realistic here) rather than dictionary size (not), so the measured index sizes are the right order of magnitude but should be treated as a **floor**. Everything else (plans, `rows_read`, latencies) is unaffected by vocabulary.

---

## Claim 2: cross-database joins

**Confirmed. D1 cannot query across databases, and the prohibition is deliberate and stated as permanent.** Constraint (1) of #6 is safe.

This one deserves a note about where the answer lives, because it is not where anyone would look. **The D1 documentation is completely silent.** Across all 52 pages, including the [FAQ](https://developers.cloudflare.com/d1/reference/faq/), the release notes back to 2022, and the page titled "SQL statements", the strings `ATTACH`, `DETACH`, "cross-database", "across databases" and "join across" do not appear once. There is no unsupported-SQL-statements list anywhere in the D1 docs. The nearest thing is a row in the [debug guide](https://developers.cloudflare.com/d1/observability/debug-d1/) advising _"shard your data into multiple databases"_ when you exceed the size limit, without addressing how you would then query them.

The answer is in the source file the SQL-statements page links to for "the full list of supported functions", `cloudflare/workerd`'s `src/workerd/util/sqlite.c++`. Under the heading `// Stuff that is never allowed`, verbatim:

```cpp
    case SQLITE_ATTACH: /* Filename        NULL            */
    case SQLITE_DETACH: /* Table Name      NULL (modified) */
      // We do not support attached databases. It seems unlikely that we ever will.
      return false;
```

and, unconditionally, `sqlite3_limit(db, SQLITE_LIMIT_ATTACHED, 0);`. The exact commit the docs pin (`4c42a4a`) carries the identical comment.

Measured against the runtime, which is the part that actually matters:

| Probe                                 | Result                                      |
| ------------------------------------- | ------------------------------------------- |
| `ATTACH DATABASE 'other.db' AS other` | `D1_ERROR: not authorized: SQLITE_AUTH`     |
| `DETACH DATABASE other`               | `D1_ERROR: not authorized: SQLITE_AUTH`     |
| `SELECT * FROM other.some_table`      | `D1_ERROR: no such table: other.some_table` |
| `CREATE TEMP TABLE t (a TEXT)`        | `D1_ERROR: not authorized: SQLITE_AUTH`     |
| `CREATE TEMPORARY VIEW v AS SELECT 1` | `D1_ERROR: not authorized: SQLITE_AUTH`     |

The temp-object probes are there because staging a cross-database copy in `temp` is the obvious workaround, and it is closed too. `workerd`'s comment explains why: _"Creating a temporary table actually causes SQLite to open a separate temporary file to place the data in. Currently, our storage engine has no support for this."_

**What this means for #6.** Constraint (1) is not just correct, it is stronger than #6 states. #6 says D1 "has no cross-database joins"; the accurate statement is that D1 forbids all cross-database access, permanently, by design, and this is undocumented so nobody will discover it from the docs. Two consequences #6 does not draw:

- The tenancy fallback in #6, database-per-store with each carrying its own mirror, remains viable, but it forecloses **any** cross-store query forever: no group reporting, no "which of our shops has this card", no consolidated buylist. That is not a cost #6 weighs. Under [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)'s one-database-plus-`storeId` decision it does not arise, and the "cheap insurance" measures #6 lists are the right hedge.
- Any future service that wants to read the mirror must do so through a Worker, not through SQL.

---

## Claim 3: faceted search at ~150k rows

Corpus: 150,000 Catalogue printings (110k Magic, 20k Pokémon, 13k Yu-Gi-Oh, 7k tail), 4,000 stock rows for one store, plus a second 60,000-SKU store to test sensitivity. Sixteen columns per printing, on the fields you would actually filter, sort and display on. Each figure is the median of seven runs; `rows_read` is D1's own counter, which is what billing uses.

### The good case

| Query                                                       | Median | `rows_read` |
| ----------------------------------------------------------- | -----: | ----------: |
| Faceted browse: game + rarity + colour, name-sorted, page 3 |   1 ms |       1,146 |
| The same, with a covering index                             |  <1 ms |          60 |
| Facet count (result total for the pagination UI)            |  <1 ms |       2,713 |
| **Faceted in-stock, price-sorted, page 3** (the #6 query)   |   5 ms |       6,042 |
| Facet count, in-stock                                       |   2 ms |       2,875 |
| The same, with available-to-promise computed inline         |   5 ms |       9,502 |
| Non-Magic game (Pokémon, rarity facet)                      |  <1 ms |          60 |
| Multi-select facets (`rarity IN`, `colour IN`)              |  10 ms |      27,543 |
| Deep pagination (`OFFSET 2000`)                             |  24 ms |      34,587 |
| **Unindexed** faceted browse, for contrast                  |  10 ms |     152,712 |

The plans are sane. `EXPLAIN QUERY PLAN` on the load-bearing query:

```
SEARCH s USING INDEX stock_price (store_id=?)
SEARCH p USING INDEX sqlite_autoindex_catalogue_printing_1 (id=?)
```

and with available-to-promise folded in, the Hold subquery resolves through its own index rather than scanning:

```
SEARCH s USING INDEX stock_price (store_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH h USING INDEX hold_stock_expiry (stock_id=? AND expires_at>?)
SEARCH p USING INDEX sqlite_autoindex_catalogue_printing_1 (id=?)
```

So #6's central claim, that available-to-promise computes in the same query, is verified, at 9,502 rows read and 5 ms.

`rows_read` is real in this harness: the control full scan read exactly 150,000.

### The bad tail: a selective facet reads the whole stock table

The price-sorted in-stock query drives from `stock` using `(store_id, sell_price)`, walking the store's inventory in price order and probing the mirror for each row until it has filled a page. When the facet is common, it stops early. **When the facet matches nothing, there is no early stop, and it reads the store out.**

| Query                                                 |     Median | `rows_read` | Returned |
| ----------------------------------------------------- | ---------: | ----------: | -------: |
| In-stock, common facet, 4,000-SKU store               |       5 ms |       6,042 |       20 |
| In-stock, common facet, 60,000-SKU store              |       7 ms |       6,513 |       20 |
| In-stock, **facet with no matches**, 4,000-SKU store  |       6 ms |       7,510 |        0 |
| In-stock, **facet with no matches**, 60,000-SKU store | **109 ms** | **112,803** |        0 |
| The same empty facet, facets denormalised onto stock  |  **<1 ms** |       **0** |        0 |

So the cost is bounded not by the mirror's size but by the store's stock, and only in the tail. At the volume #6 assumes, one physical store with "a few thousand rows", the worst case is 7,510 rows and 6 ms, which is nothing. At 60,000 SKUs the worst case is 113,000 rows read and 109 ms **to return zero results**, and a kiosk browsing empty facets would hit it repeatedly against a database Cloudflare documents as _"inherently single-threaded"_.

The fix is to copy the facet columns onto the store-owned table so the sort and the filter share one index:

```
SEARCH stock_denorm USING INDEX sd_facet (store_id=? AND game_system=? AND rarity=? AND colour_identity=?)
```

0 to 63 rows read, sub-millisecond, at any facet selectivity. **This is where the measurement pushes back on #6.** #6 says: _"Stock is a separate table (`printingId`, condition, quantity, prices) joined at query time."_ That is correct at the volume #6 assumes and wrong an order of magnitude above it. The remedy is a small denormalisation of Catalogue-owned attributes onto a store-owned table, which cuts against #6's clean ownership split, and needs to be understood as what it is: a second derived read model, maintained by the same sync module, with the same "holds no facts of its own, rebuildable by re-seeding" property the mirror has. It is not a change of architecture. It is a row in the build checklist, and it does not need doing for the MVP.

### Indexes: what the planner actually did

- **Composite indexes behave exactly as documented**, leftmost-prefix rule and all.
- **Covering indexes are worth having.** Adding `(game_system, rarity, colour_identity, name, set_code, market_price)` took the browse query from 1,146 rows read to 60. The planner reported `USING INDEX cp_facet_covering` and never touched the table.
- **Partial indexes are supported but were not chosen.** `CREATE INDEX … WHERE game_system = 'magic'` built in 54 ms. The planner ignored it, both with a bound `game_system = ?1` and with a literal `game_system = 'magic'`, after `PRAGMA optimize`, preferring the full composite `cp_game_rarity`. Answer to the ticket's secondary question: **supported, and useless for this shape**, because every composite index already leads with `game_system` and so is a superset of what a per-game partial index offers. They would matter for a genuinely sparse predicate such as `WHERE quantity > 0`, not for game-scoping.
- **`PRAGMA optimize` is supported** and was run after every index change. (`PRAGMA optimize(-1)` is documented as unsupported.)
- **Multi-select facets cost roughly 25 times a single-select facet** (27,543 against 1,146 rows read) because the `IN` list forces `USE TEMP B-TREE FOR ORDER BY`. Still 10 ms; worth knowing before the filter UI grows.
- **`OFFSET` pagination scans.** `OFFSET 2000` read 34,587 rows for 20 results. Keyset pagination would fix it; at storefront page depths it does not matter.

---

## Limits, measured against the documentation

Every documented limit was probed rather than taken on trust. The [limits page](https://developers.cloudflare.com/d1/platform/limits/) (2026-04-21) is accurate where it speaks, and silent on two things that bite.

| Limit                        | Documented         | Measured                                                                                         |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| Bound parameters per query   | 100                | **exactly 100**; 101 gives `variable number must be between ?1 and ?100`                         |
| SQL statement length         | 100,000 bytes      | **exactly 100,000**; 119,997 gives `statement too long: SQLITE_TOOBIG`                           |
| Terms in a compound `SELECT` | **not documented** | **5**; 6 gives `too many terms in compound SELECT`                                               |
| `sqlite_version()`           | not documented     | **refused**, `not authorized to use function`                                                    |
| Statements per `batch()`     | **not documented** | not probed; only the per-statement limits and the 1,000-queries-per-invocation cap are published |

The compound-`SELECT` cap of 5 is the one to carry forward: it is set in `workerd` (`sqlite3_limit(db, SQLITE_LIMIT_COMPOUND_SELECT, 5)`), appears nowhere in Cloudflare's documentation, and **kills any multi-select facet implemented as a `UNION` of per-value queries**. Use `IN` lists. Two further undocumented ceilings sit in the same file, not probed here: `SQLITE_LIMIT_EXPR_DEPTH` 100 and `SQLITE_LIMIT_VDBE_OP` 25,000.

The published table and the source also disagree in two places: `SQLITE_LIMIT_FUNCTION_ARG` is 127 in code against "32" in the docs, and `SQLITE_LIMIT_LENGTH` is 4 MB against "2,000,000 bytes". Plan against the documented, conservative figures.

### Bulk import

The documented import path is `wrangler d1 execute --file`, capped at 5 GB (the limits table) or 5 GiB (the import page; the two pages disagree on the unit). There is no `wrangler d1 import` command. Cloudflare's guidance when a file fails:

> "If you encounter a `Statement too long` error … convert the single large `INSERT` statement into multiple smaller `INSERT` statements. For example, instead of inserting 1,000 rows in one statement, split it into four groups of 250 rows."

**The documentation says nothing at all about how long a large import takes**: no throughput figure, no wall-clock guidance, nothing about resumability.

Measured, packing the 150,000-row seed into multi-row `INSERT`s under a 90,000-byte ceiling:

- **379 statements**, roughly 396 rows each, largest 90,001 bytes.
- Because bound parameters cap at 100, a bulk seed **must inline escaped literals**. At 16 columns, binding would allow 6 rows per statement.
- 300,000 `rows_written` for 150,000 rows. A `TEXT PRIMARY KEY` creates `sqlite_autoindex_…`, so every insert writes two billed rows before any secondary index.
- All seven indexes built in **0.6 s total**, each reporting 150,001 `rows_written`.

**The local duration figure (roughly 170,000 rows/s) is meaningless for a real D1** and is deliberately not quoted as a result. See [What remains unverified](#what-remains-unverified).

### Write amplification and billing

`rows_written` per Catalogue row is 1 (table) + 1 (`TEXT PRIMARY KEY` autoindex) + one per secondary index. Measured with seven secondary indexes in place: **9.0 billed rows written per row**, so a full 150k re-seed is **roughly 1.35M `rows_written`**. A 2,000-row market-price delta wrote 4,000 rows, 2.0 per row: the table plus the one index covering `market_price`.

Against [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) on Workers Paid (50 million rows written included per month then $1.00/million; 25 billion rows read included then $0.001/million) none of this is a cost problem. A full re-seed is 2.7% of the monthly write allowance. At 6,000 rows read for the heaviest common query, the read allowance covers roughly 4 million storefront queries a month. **The constraint that binds is not billing; it is the 30-second query cap and the single-threaded database.** Which is why the 113,000-row empty-facet tail matters and the money does not.

An index reduces rows read and increases rows written, and Cloudflare states it plainly: _"an index is effectively a table itself"_ and _"A query that scans an entire table to return a single row is billed for every row it scans."_ **How FTS5 virtual-table reads and writes are counted is undocumented**, and the shadow tables are not visible to `rows_read` in any way this spike could confirm.

Note, carried from the data-layer research: since **2026-09-01** D1 hard-enforces Free-plan daily row limits, and queries fail until midnight UTC once exceeded. Run on Workers Paid.

---

## Storage: #6's estimate is wrong twice, and it does not matter

Issue #6 estimated ~150k rows at roughly **400 bytes each, about 60 MB**. Measured, on sixteen columns covering everything the storefront filters, sorts or displays:

| Stage                                                                    |     Size | Bytes/row |
| ------------------------------------------------------------------------ | -------: | --------: |
| Empty database                                                           |    24 KB |       n/a |
| Logical payload (text + numerics, no SQLite overhead)                    |  27.0 MB |       180 |
| Data only, no indexes                                                    |  35.4 MB |   **236** |
| Plus seven B-tree indexes                                                |  54.7 MB |       355 |
| Plus an FTS5 index over `name`, `set_name`, `type_line`                  |  79.2 MB |       n/a |
| Plus a trigram index over `name`                                         |  96.2 MB |       n/a |
| Final, including the denormalised stock table and a second 60k-SKU store | 112.2 MB |       n/a |

Two corrections to #6, pulling in opposite directions:

- **Per row, #6 was pessimistic.** 236 stored bytes, not 400. The estimate had roughly 70% headroom on the payload.
- **In total, #6 was optimistic, because it counted the data and not the search index.** A mirror you can actually search costs **about 96 MB**, not 60 MB. The indexes and FTS5 that make it a search index are 63% of it, and #6's figure counts none of them.

Against D1's 10 GB hard ceiling that is **about 1%**, so the decision is untouched. #6's "if every Magic language is carried, ~200 MB" scales to roughly 350 to 400 MB all-in, which is still 4%. The number in #6 should simply be corrected to _"~60 MB of data, ~100 MB once it is searchable"_ so nobody budgets against the wrong figure later.

---

## What remains unverified

**This spike ran on local workerd/miniflare only.** The Wrangler OAuth token available carries no D1 scope at all (`account:read`, `user:read`, `workers:write`, `workers_kv:write`, `workers_routes:write`, `workers_scripts:write`, `workers_tail:read`), so no remote database could be created or read, and the ground rules for this spike forbade provisioning one regardless. **This is the same outstanding obligation the [#4 spike](../../spike/d1-hold-atomicity/README.md) left open, and it is left open again deliberately rather than papered over.**

What should transfer unchanged, because it is SQLite-level and enforced by the same `workerd` authorizer that backs both: every capability answer, every query plan, every `rows_read` count, every limit.

What must be re-measured against a real D1 database before it is trusted:

1. **Wall-clock latency.** Every millisecond figure here excludes the network and the single-threaded Durable Object a real D1 runs inside, and benefits from a warm in-process page cache. The _relative_ ordering (denormalised, then indexed join, then the empty-facet tail, then unindexed `LIKE`) should hold; the absolute numbers will not.
2. **Bulk-load duration.** The ticket asks how long a ~150k-row seed actually takes. **This spike cannot answer that.** The local figure is an artefact of in-process SQLite. The real question is how long 379 statements take over the wire against a single-threaded remote database, against a 30-second per-call cap that also applies to a whole `batch()`.
3. **Whether `rows_read` and `rows_written` are counted identically remotely.** Every billing figure above rests on the local counter matching production. `workerd` carries a patch named `0001-row-counts-plain.patch`, which suggests the counting is Cloudflare's own; whether miniflare applies it identically is **unverified**.
4. **FTS5 billing.** Undocumented, and not separable locally.
5. **Read replication's effect**, if it is ever enabled. It is still labelled public beta as of the last changelog entry (2025-04-10), with no GA announcement.

Also unverified, and worth naming: the corpus is generated. Its **534 distinct FTS5 terms** badly under-represent a real catalogue's vocabulary, so the FTS5 index sizes are a floor. Real Catalogue payloads may also carry fields this schema omits, such as oracle text and rulings, which would move the bytes-per-row figure up.

---

## What to carry into the build

1. **Co-locate the mirror and stock in one D1 database.** Confirmed necessary, permanently. Keep #6's cheap insurance: namespace Catalogue tables separately, write the sync job against _a_ binding, `storeId` on every store-owned table.
2. **Never write `name LIKE ?` without a `COLLATE NOCASE` index on the same column.** 92 ms and 110,000 rows read against under 1 ms and 238.
3. **Use FTS5 for name search**, external-content over `catalogue_printing`, plus a **separate trigram index** if mid-name substring search is wanted. They are different indexes and cost roughly the same each.
4. **The sync module must write the FTS index on every delta**, a `'delete'` command then a reinsert, or via triggers. An external-content index goes silently stale otherwise, and a kiosk showing the wrong card name is the worst failure this system has.
5. **Accept that `wrangler d1 export` stops working** once an FTS5 table exists. Time Travel remains. Recovery is a re-seed, which #6 already assumes.
6. **Every composite index leads with `game_system`**, matching #6's constraint 5. Add a covering index for the hot browse facet. Skip per-game partial indexes; the planner does not use them.
7. **Bulk seed with inlined literals, packed to roughly 90 KB per statement**, batched. Bound parameters cap at 100, so binding is not an option at 16 columns.
8. **Multi-select facets use `IN`, never `UNION`.** Compound `SELECT` is capped at 5 terms, undocumented.
9. **Not for the MVP, but write it down:** if a store's SKU count approaches five figures, denormalise `game_system`, `rarity` and the game's facet columns onto the stock table, so the price-sorted in-stock query filters and sorts on one index. It is a second derived read model, fed by the same sync, and it takes the empty-facet worst case from 113,000 rows read to zero.
10. **Correct #6's storage figure** to about 100 MB searchable, and its per-row figure to about 240 bytes.

---

## Sources

Cloudflare (primary, all fetched 2026-09-07):

- [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) · [Limits](https://developers.cloudflare.com/d1/platform/limits/) · [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/) · [Use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) · [FAQ](https://developers.cloudflare.com/d1/reference/faq/) · [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/) · [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) · [Release notes](https://developers.cloudflare.com/d1/platform/release-notes/) · [Changelog](https://developers.cloudflare.com/changelog/rss/d1.xml) · [Wrangler `d1` commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- [`workerd` `src/workerd/util/sqlite.c++`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B), the SQLite authorizer that actually governs D1: the source of the `ATTACH` prohibition, the FTS5/rtree virtual-table allowlist, the temp-object refusal, and the undocumented limits
- [`workerd` `MODULE.bazel`](https://raw.githubusercontent.com/cloudflare/workerd/main/MODULE.bazel), the SQLite pin (`sqlite-src-3530400`)

SQLite (primary):

- [FTS5](https://www.sqlite.org/fts5.html) for tokenizers, `prefix=`, `content=`, `contentless_delete` and `fts5vocab` · [Change log](https://www.sqlite.org/changes.html) for trigram in 3.34.0 and contentless-delete in 3.43.0

Measurements:

- [`spike/d1-search/`](../../spike/d1-search/): `capabilities.test.ts` (capability and limit probes) and `scale.test.ts` (the 150k-row measurement run)
