# Spike: hand-rolled trigram overlap on D1

**Throwaway spike, not app code.** Item 2 of
[issue #25](https://github.com/KeeprDigital/shop-keepr/issues/25). Findings live in
[`docs/research/2026-09-08-typo-tolerant-search-options.md`](../../docs/research/2026-09-08-typo-tolerant-search-options.md).

## The question

[#16](https://github.com/KeeprDigital/shop-keepr/issues/16) concluded that D1 can do
typo tolerance only by hand-rolling a `printing_trigram(trigram, printing_id)` table,
named it *"~3M rows at 150k printings"*, and left its read cost unmeasured — guessing it
lands in [#13](https://github.com/KeeprDigital/shop-keepr/issues/13)'s
113,000-rows-read tail. This measures it: rows read, latency, index size, write
amplification on re-seed, and the zero-result-fallback variant.

## The answers

**#16's guess was right in kind and wrong about the consequence.** The mechanism as
described reads **255,059 rows** — 2.3× the tail it feared — but does it in **17 ms**,
a fifth of that tail's 109 ms, because it walks a covering index instead of scanning a
table with heap probes.

**#16 measured the wrong table.** Indexing trigrams per **distinct name** and joining to
Printings gives the identical answer at **64,492 rows read and 4–5 ms**, on **27%** of the
storage and **25%** of the write amplification. The Catalogue holds many Printings per
name, so the per-Printing table pays for the same name repeatedly. Not considered by #16.
The gap widens at 500k Printings, because the per-name table's cost is a function of
distinct names, not of Printings.

**The fallback is free when it does not fire.** Determining that the cheap folded-column
path missed costs **0 rows read and 0 ms**.

| | Shape A (per Printing, #16's) | Shape B (per distinct name) |
| --- | ---: | ---: |
| Rows | 2,515,715 | **634,802** |
| Size | 157.0 MB | **42.6 MB** |
| `rows_read` for one query | 255,059 | **64,492** |
| Median | 17 ms | **4–5 ms** |
| Full re-seed `rows_written` | 2,515,715 | **634,802** |

## The corpus finding, which matters beyond this spike

The test runs the **same schema and the same query on two corpora**, and they disagree by
5.5×:

| Corpus | Distinct names | Distinct trigrams | `rows_read` | Median |
| --- | ---: | ---: | ---: | ---: |
| Generated (`spike/d1-search/seed.ts`, #13's) | 9,000 | **405** | 1,391,435 | 109 ms |
| Real (38,001 real card names) | 38,001 | **7,053** | **255,059** | **17 ms** |

#13 flagged its 534-term vocabulary as a limitation for FTS5 index *size*. It turns out to
be decisive for trigram *read cost*, which #13 did not measure — the generated corpus's
most common trigrams are `"  o"` at 85,491 rows and `" of"` at 80,898, so every trigram is
catastrophically unselective. **No trigram figure taken on the generated corpus should be
quoted again.** Real names come from [`spike/typo-search/`](../typo-search/).

## Run it

```bash
pnpm install
node_modules/.bin/vitest run --config spike/d1-trigram/vitest.config.ts \
  --reporter=verbose --disable-console-intercept
```

`--disable-console-intercept` is what surfaces the measurement numbers.

## Layout

| File | What it is |
| --- | --- |
| `trigram.test.ts` | The whole measurement run: both corpora, both table shapes, plans, selectivity, write amplification. |
| `wrangler.jsonc`, `worker.ts`, `vitest.config.ts` | Harness, copied from `spike/d1-search/`. |

The corpus generator and statement packer are imported from
[`spike/d1-search/seed.ts`](../d1-search/seed.ts) unchanged, so the row counts, PRNG seeds
and statement packing are identical to #13's and the numbers are comparable.

## The outstanding obligation

**This ran on local workerd/miniflare only** — the same gap
[#13](../d1-search/README.md) and [#4](../d1-hold-atomicity/README.md) left open. No
remote D1 was reachable and this ticket's ground rules forbade provisioning one.

What should transfer unchanged: query plans, `rows_read` counts, row counts, index sizes.
What must be re-measured against a real D1: wall-clock latency, and whether `rows_read` is
counted identically remotely — every billing figure rests on that.
