# Spike: the D1 spikes, re-run against a real D1 database

**Throwaway spike, not app code.** Discharges
[issue #17](https://github.com/KeeprDigital/shop-keepr/issues/17): every earlier D1 spike
([#4](../d1-hold-atomicity/), [#13](../d1-search/), [#25](../d1-trigram/),
[#24](../token-trigram/)) ran on local workerd/miniflare only. This one runs the same
measurements from a **deployed Worker against a remote D1 database**, where the numbers
matter. Raw output is in [`results/`](results/).

Measured 2026-09-10. Worker in colo **MEL**, D1 in region **OC**, client in AU. Client → Worker
RTT 14–16 ms. Account is Workers Paid (2.0M `rows_written` in a day went through; the free tier
stops at 100k).

## What transfers unchanged from local

- **`rows_read` is counted identically.** Every query re-run here returned the *same*
  `rows_read` as the local spike: faceted in-stock 6,042; empty-facet tail 112,803; FTS5 39;
  FTS5 + facets + stock 20,194; bound-parameter `LIKE` 110,119; multi-select 27,543; trigram
  `MATCH` 19. Every billing estimate that rested on the local counter stands.
- **Hold atomicity.** 16,250 reservation attempts, **zero oversell**, same scenarios as #4
  (concurrency 2/10/50/200 direct, 25-way `batch()`, 25-way HTTP from separate Worker
  invocations, partial quantities, mixed sizes). The negative control overselled maximally
  (25 of 25, in 50 of 50 iterations). Every `batch()` conditionality case reproduces:
  the unconditional follow-on still corrupts `on_hand`; the `AND EXISTS` gate fixes it; a
  failing batch rolls back.
- **Query plans** and index choices are identical.
- **The per-token trigram table** is exactly 222,579 rows, as #24 predicted.

## What does not transfer: wall-clock

**Every query pays a ~20 ms floor from Worker to D1.** `SELECT 1` is 20 ms wall with a D1
`duration` of 0.11 ms. The ~1 ms local figures were in-process SQLite; remotely they are all
~20 ms, and from the counter (client → Worker → D1 → back) a cheap query is ~35 ms.

| Query | Local median | Remote wall (median) | D1 `duration` | `rows_read` |
| --- | ---: | ---: | ---: | ---: |
| `SELECT 1` (round-trip floor) | — | 20 ms | 0.11 ms | 0 |
| Point lookup by primary key | — | 19 ms | 0.13 ms | 1 |
| Faceted browse, covering index | <1 ms | 20 ms | 0.3 ms | 60 |
| Facet count | <1 ms | 19 ms | 0.3 ms | 2,713 |
| Deep pagination (`OFFSET 2000`) | 24 ms | 21 ms | 0.55 ms | 2,020 |
| Multi-select facets | 10 ms | 55 ms | 33 ms | 27,543 |
| **Faceted in-stock, price sort, 4k SKUs** (the #6 query) | 5 ms | 40 ms | 18 ms | 6,042 |
| Faceted in-stock, 60k SKUs | 7 ms | 47 ms | 26 ms | 6,513 |
| Faceted in-stock with ATP inline | 5 ms | 42 ms | 21 ms | 9,282 |
| **Empty facet, 60k-SKU store** (the #13 tail) | 109 ms | **408 ms** | 380 ms | 112,803 |
| Empty facet, 4k-SKU store | 6 ms | 43 ms | 23 ms | 7,510 |
| Same empty facet, denormalised (ADR 0008) | <1 ms | 19 ms | 0.18 ms | 0 |
| Faceted in-stock, denormalised | — | 20 ms | 0.36 ms | 63 |
| FTS5 single token | 4 ms | 38 ms | 18 ms | 39 |
| FTS5 two tokens | 1 ms | 24 ms | 3.5 ms | 39 |
| FTS5 prefix token | 5 ms | 39 ms | 19 ms | 39 |
| FTS5 phrase | 2 ms | 24 ms | 3.9 ms | 39 |
| FTS5 + game facet + stock, price-sorted | 6 ms | 42 ms | 20 ms | 20,194 |
| Trigram-tokenizer `MATCH` substring | <1 ms | 21 ms | 0.4 ms | 19 |
| `LIKE 'Thundering Sent%'`, bound parameter | 92 ms | **358 ms** | 318 ms | 110,119 |
| `printing_detail` by primary key | — | 20 ms | 0.19 ms | 1 |

Reading: anything under ~3,000 `rows_read` is the network floor; the 100k-row scans are
**3.5–4× slower** on real D1 than locally (408 ms and 358 ms against 109 ms and 92 ms).
The denormalisation remedy in ADR 0008 is therefore more necessary, not less: it takes the
tail from 408 ms to the 19 ms floor.

## Seeding the mirror (#14's shape)

One `batch()` per page, inline literals, 90 KB per statement.

| Load | Rows | Rows / statement | Page | Wall per page | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| `catalogue_printing` (16 columns, ~230 B/row) | 150,000 | **392** | 20,000 rows = 51 statements, one batch | 0.5–1.2 s | **5.2 s** |
| `printing_detail` (synthetic 1,353 B JSON record) | 150,000 | **64** | 10,000 rows = 156 statements, one batch | 1.3–3.4 s | **36 s** |
| `stock`, 4,000 SKUs | 4,000 | 1,333 | one batch | 0.44 s | |
| `stock`, 60,000 SKUs | 60,000 | 1,333 | 33 statements, one batch | 0.30 s | |
| Eight indexes | | | | | 2.3 s |
| FTS5 external-content index | 150,000 | | | | 0.39 s |
| FTS5 trigram-tokenizer index | 150,000 | | | | 3.3 s |
| Per-token trigram table + covering index | 222,579 | 4,637 | one batch | | 1.3 s |

- **Statement cap: exactly 100,000 bytes.** 100,000 succeeds; 100,001 fails with
  `D1_ERROR: statement too long: SQLITE_TOOBIG`.
- **No `batch()` statement-count limit found.** 1,000 / 5,000 / 20,000 / 50,000 / 100,000
  statements in one `batch()` all succeed (100,000 in 11.2 s).
- **The 30 s cap is not a constraint at this scale.** A 20,000-row page lands in under a
  second; the whole 150k Printing seed for every game would fit inside one step. Pages of
  20k rows for `printing`, 10k for `printing_detail` leave a 10× margin.
- **`rows_written`:** 2 per Printing on a bare table (row + primary-key index); **7 per
  Printing** once all five catalogue indexes exist (5,000-row re-seed: 35,000 written);
  2 per row for a price-only `UPDATE`. Each `CREATE INDEX` over 150k rows writes 150,001.
- **Storage:** 35 MB for 150k Printings bare; +33 MB for the eight indexes; +7.6 MB FTS5;
  +17 MB trigram FTS5; +11.7 MB per-token trigram table; **+304 MB for `printing_detail`**
  (2 KB stored per 1,353-byte record — 1.5× the logical size). 412 MB in total, 108 MB
  without `printing_detail`.

**On the `printing_detail` size:** the map forbids reading the Catalogue's current export,
so the record here is a *stand-in* — the Printing's fields plus images, oracle and flavour
text, an 18-format legalities map, keywords and revision — not a measured Catalogue record.
#15's "2 KB × 200k ≈ 400 MB" guess lands in the right range for a record of this shape
(≈ 300 MB at 150k, ≈ 400 MB at 200k). Measure it against the real export when the
Catalogue's contract freezes.

## Hold atomicity on real D1 (#4)

| Scenario | Attempts | Oversell | Per-statement wall (median → p95) |
| --- | ---: | ---: | --- |
| Direct binding, concurrency 2 | 100 | 0 | 35 → 39 ms |
| Direct binding, concurrency 10 | 500 | 0 | 49 → 66 ms |
| Direct binding, concurrency 50 | 2,500 | 0 | 130–160 → 150–260 ms |
| Direct binding, concurrency 200 | 10,000 | 0 | 425–617 ms |
| `batch()`, concurrency 25 | 1,250 | 0 | 80 → 90–350 ms |
| HTTP, 25 separate Worker invocations | 1,250 | 0 | 55 → 72 ms (in-Worker) |
| Partial quantities (qty 2 × 3 against 5) | 150 | 0 — exactly 2 granted every time | 48 ms |
| Mixed sizes against 7 | 500 | 0 over-commits | |
| Negative control (naive JS read-then-write, 25-way) | 1,250 | **50 of 50 iterations, 25 of 25 granted** | |

A single warm reserve statement: **34 ms wall, 0.26 ms in D1, 11 `rows_read`**. D1
serialises the concurrent statements — 200 in flight cost ~500 ms each, i.e. ~400
reservations per second per database — which is irrelevant at one store's kiosk volume and
is the price of not having a Durable Object.

## The per-token trigram fallback (#24)

Built from the 38,001 real names: 23,600 tokens, **222,579 rows** (as predicted), 11.7 MB
with its covering index, loaded in one 48-statement batch in 0.9 s plus 0.5 s for the index.
Plan: `SEARCH token_trigram USING COVERING INDEX token_trigram_covering (trigram=?)`, then
two temp B-trees (`GROUP BY`, `ORDER BY`). 200 of #24's 400 substituted-token queries:

| | Predicted (posting-list arithmetic) | Measured on D1 |
| --- | ---: | ---: |
| `rows_read` per query token, mean | 4,051 | **11,343** |
| `rows_read`, p95 | 7,503 | **19,873** |
| Rarest-5 trigrams only, mean | 138 | **412** (p95 1,030) |
| Wall-clock, median / p95 | — | **25 / 32 ms** (D1 `duration` 3.4 / 6.9 ms) |
| Rarest-5 wall-clock, median / p95 | — | 21 / 24 ms |
| Cheap folded-column path, a miss | 0 | **0 `rows_read`**, 21 ms |

**The prediction was wrong by 2.8×, consistently.** Not one of 200 queries matched the
arithmetic; the ratio is stable across the full and rarest-5 shapes, so D1 is counting the
temp B-tree traffic (`GROUP BY` then `ORDER BY` over the posting rows) as reads. Time is
unaffected — the tier resolves in 3–7 ms of D1 time and sits on the 20 ms floor. As #24
said, this changes tuning, not the decision: the rarest-5 lever cuts the read to 412 rows,
a 28× cut as predicted. **The cheap path missing costs 0 rows**, so the fallback stays off
the hot path.

## Backup with FTS5 present (#20)

- `wrangler d1 export --remote` on the full database: **fails**, `D1 Export error: cannot
  export databases with Virtual Tables (fts5)`. `--no-data` (schema only) fails the same way.
- **`--table <name>` works** on any ordinary table with FTS5 present: `stock` (64,000 rows)
  exported to 10 MB in ~10 s; two tables in one call also works. So the ledger and every
  store-owned table can be exported table-by-table; only the whole-database dump is blocked.
- **Time Travel works**: `wrangler d1 time-travel info` returns a restorable bookmark.

## Postgres through Hyperdrive — not measured

Item 2 of the ticket needs a hosted Postgres; the account has none and no Hyperdrive config.
[#20](https://github.com/KeeprDigital/shop-keepr/issues/20) resolved on grounds independent
of this number, so it is no longer load-bearing. The figure it would be compared against is
now known: **~20 ms per query, Worker to D1, same region.**

## Run it

```bash
node_modules/.bin/wrangler d1 create shop-keepr-d1-spike       # put the id in wrangler.jsonc
cd spike/d1-remote
../../node_modules/.bin/wrangler deploy --var SPIKE_TOKEN:$(openssl rand -hex 16)
SPIKE_URL=https://shop-keepr-d1-remote-spike.<subdomain>.workers.dev SPIKE_TOKEN=… node drive.mjs
../../node_modules/.bin/wrangler d1 export shop-keepr-d1-spike --remote --output /tmp/x.sql   # the FTS5 export check
```

Stages: `ping hold partial probes search trigram`. The Worker and database were deleted after
the run; the whole exercise cost 4.4M `rows_read` and 2.0M `rows_written`.

## Layout

| File | What it is |
| --- | --- |
| `worker.ts` | Every measurement as an endpoint. Imports the hold statement, corpus, schema and queries from the earlier spikes unchanged. |
| `drive.mjs` | Runs the endpoints in order from the client and writes `results/*.json`. Also fires the 25-way HTTP stampede. |
| `results/` | Raw output: `ping`, `hold`, `hold-partial`, `probes`, `search`, `trigram`. |
| `wrangler.jsonc` | Worker config; needs the real database id. |
