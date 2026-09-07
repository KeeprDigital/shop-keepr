# Spike: Postgres full-text and faceted search at 150k rows

Throwaway. Supports [#19](https://github.com/KeeprDigital/shop-keepr/issues/19), which re-examines the Postgres rejection in [#2](https://github.com/KeeprDigital/shop-keepr/issues/2). Findings live in [`docs/research/2026-09-07-postgres-on-workers-reeval.md`](../../docs/research/2026-09-07-postgres-on-workers-reeval.md). Delete this directory when the ticket is closed.

## What it answers

Whether Postgres `tsvector`/GIN full-text at ~150k rows is competitive with the 1–6 ms / 39 `rows_read` FTS5 delivered on D1 in [`spike/d1-search`](../d1-search/) — and whether Postgres's cost-based planner avoids the 109 ms / 112,803-rows-read empty-facet tail that spike found.

## Why the numbers are comparable

`gen.mjs` is a plain-JS port of [`spike/d1-search/seed.ts`](../d1-search/seed.ts): same `mulberry32` PRNG, same seeds (`0x5EED1234` for printings, `0xF00D9876` for stock), same word lists, same 110k/20k/13k/4k/3k game split, same 4,000- and 60,000-SKU stores. It prints its own distinct-term count (533) as an identity check against the D1 spike's 534 FTS5 terms.

`schema.sql` is the D1 schema transliterated column-for-column, keeping [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)'s two portability disciplines — money as integer minor units, timestamps as epoch-ms integers. No `NUMERIC`, no `timestamptz`: the point is to measure the port that would actually be made, not a redesign.

`indexes.sql` builds the same seven B-trees the D1 spike used, plus the three things under test: a `GENERATED ALWAYS AS … STORED` tsvector with a GIN index, a `pg_trgm` GIN index, and a `text_pattern_ops` B-tree (Postgres's version of the `COLLATE NOCASE` trap the D1 spike found). Full text uses the `simple` configuration, not `english`, because FTS5's default `unicode61` tokenizer does not stem.

## Run it

Needs Docker. Nothing hosted, nothing provisioned, no account.

```sh
node gen.mjs          # writes data/*.tsv  (~32 MB, gitignored)
./run.sh              # brings up postgres:17-alpine, loads, indexes, benchmarks
docker exec -i shopkeepr-pg-spike psql -U postgres -d shopkeepr -f - < probes.sql
docker rm -f shopkeepr-pg-spike
```

`run.sh` leaves the container running so `probes.sql` can be run against it. Seven runs per query, median reported, matching the D1 spike's methodology.

## What it cannot answer

**The comparison that decides the question.** Every figure here is server-side, warm, single-client, local — as are the D1 figures it is compared against. Neither includes a network, and the entire Postgres argument turns on the network. Cloudflare's only published figure for an uncached query through Hyperdrive is ~500 ms cross-region; the same-region figure is undocumented.

Settling it needs a deployed Worker and a hosted database, which this ticket's ground rules forbid provisioning. Recorded as an obligation in the findings doc.
