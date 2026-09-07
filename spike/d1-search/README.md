# Spike: D1 search at catalogue scale

**Throwaway spike, not app code.** It exists to answer one question for
[issue #13](https://github.com/KeeprDigital/shop-keepr/issues/13), and it is kept only because
that issue's resolution records an obligation this harness makes cheap to discharge.

## The questions

Issue [#6](https://github.com/KeeprDigital/shop-keepr/issues/6) committed to mirroring the whole
Catalogue into D1 and serving faceted storefront search locally, on three claims asserted from
knowledge and never verified:

1. Is FTS5 available on D1, for name search over ~150k rows?
2. Can D1 join across databases?
3. Does a realistic multi-predicate faceted query behave at ~150k rows?

## The answers

1. **Yes, fully.** All four tokenizers, `prefix=`, `content=`, `contentless_delete=1`, `bm25()`,
   `snippet()`, `highlight()`, `rank`, prefix and phrase queries, and `fts5vocab` all work.
   Name search over 150k rows: **1–6 ms, 39 rows read.**
2. **No, and it is not close.** `ATTACH` returns `SQLITE_AUTH`, `CREATE TEMP TABLE` returns
   `SQLITE_AUTH`, and Cloudflare's own source says *"We do not support attached databases. It seems
   unlikely that we ever will."* Constraint (1) of #6 holds.
3. **Yes for the common case, with one bad tail.** The faceted browse resolves in 1 ms / 1,146 rows
   read. The in-stock price-sorted join resolves in 5 ms / 6,042 rows read at 4,000 SKUs. But a
   facet with no matches makes SQLite read the store's whole stock table: **113k rows read, 109 ms,
   returning nothing**, on a 60k-SKU store. Denormalising the facet columns onto the store-owned
   table takes that to **0 rows read**.

Full write-up, with the numbers and the sources:
[`docs/research/2026-09-07-d1-search-capabilities.md`](../../docs/research/2026-09-07-d1-search-capabilities.md).

## The outstanding obligation

**This ran on local workerd/miniflare only** — the same gap the
[#4 spike](../d1-hold-atomicity/README.md) left open. The Wrangler OAuth token available to the
agent carries no D1 scope (`account:read`, `user:read`, `workers*:write`, `workers_kv:write`), so
no remote database could be created or read, and the ground rules for this spike forbade
provisioning one anyway.

What should transfer unchanged, because it is SQLite-level and enforced by the same authorizer:
every capability answer, every query plan, every `rows_read` count, and every limit.

**What must be re-measured against a real D1 database before it is trusted:**

- **Wall-clock latency.** Every millisecond figure here excludes the network, the single-threaded
  Durable Object that backs a real D1, and a cold page cache.
- **Bulk-load duration.** The local 170k rows/s is an artefact of an in-process SQLite. The real
  question is how long 379 statements over the wire take, and that is unanswerable locally.
- **Whether `rows_read` is counted identically.** The billing numbers all rest on it.

```bash
pnpm install
node_modules/.bin/vitest run --config spike/d1-search/vitest.config.ts \
  --reporter=verbose --disable-console-intercept
```

To verify remotely, create a real D1 database, point `wrangler.jsonc` at it, and re-run.

## Layout

| File                  | What it is                                                      |
| --------------------- | --------------------------------------------------------------- |
| `capabilities.test.ts` | Capability probes: FTS5, `ATTACH`, temp objects, real limits.   |
| `scale.test.ts`        | One long measurement run over a 150k-row corpus.                |
| `seed.ts`              | Deterministic corpus generator, and the statement packer.       |
| `schema.ts`            | Mirror + stock tables, and the index variants under test.       |
| `queries.ts`           | The queries the storefront would actually issue.                |

## The findings that change app code

- **A parameterised `name LIKE ?` prefix search does not use an index** (92 ms, 110k rows read).
  It needs a `COLLATE NOCASE` index to be usable (0 ms, 238 rows read). This will look fine in
  development and be the slowest query in the application.
- **An external-content FTS5 index does not follow its base table.** Measured directly: renaming a
  row left the index matching the old name and not the new one. The sync module must write the FTS
  index explicitly on every delta.
- **An FTS5 table makes the whole database non-exportable** — `wrangler d1 export` is the
  documented casualty, for the database, not just the table.
- **Compound `SELECT` is capped at 5 terms**, which is undocumented and kills a multi-select facet
  implemented as `UNION`.
- **Bound parameters cap at exactly 100** and statements at exactly 100,000 bytes, so a bulk seed
  must inline literals rather than bind them.
