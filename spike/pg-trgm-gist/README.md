# Spike: does `pg_trgm` with GiST and `<->` serve similarity-ordered search?

**Throwaway spike, not app code.** Item 1 of
[issue #25](https://github.com/KeeprDigital/shop-keepr/issues/25). Findings live in
[`docs/research/2026-09-08-typo-tolerant-search-options.md`](../../docs/research/2026-09-08-typo-tolerant-search-options.md).

## The question

[#19](https://github.com/KeeprDigital/shop-keepr/issues/19) measured the Postgres planner
**declining** a trigram index under `ORDER BY … LIMIT`, which is why
[#24](https://github.com/KeeprDigital/shop-keepr/issues/24) carries the caveat that
*"`pg_trgm` is not free either"*. [#16](https://github.com/KeeprDigital/shop-keepr/issues/16)
recorded that similarity ordering needs GiST and the `<->` operator. Does it, and does it
work at 150k rows?

## The answer

**Yes.** The planner emits an index scan with a distance order and stops after the LIMIT:

```
Index Scan using cp_name_trgm_gist on catalogue_printing
  Order By: (name <-> 'Lighming Bolt'::text)
Execution Time: 21.481 ms
```

**#19's finding does not generalise** — it was about `LIKE`-shaped substring search against
a GIN index, not similarity ordering against a GiST one. Postgres's own docs say so
verbatim: *"This can be implemented quite efficiently by GiST indexes, but not by GIN
indexes."*

Four things the ticket did not ask, and they change the reading:

- **GiST costs 2.1× GIN's size** for the same column (15 MB against 6,992 kB). Undocumented
  — the pg_trgm page explicitly declines to compare them.
- **The word-similarity operators are a trap.** `<<->` and `<<<->` are the natural choice
  for typeahead and **neither uses the index**: both plan a parallel seq scan over 150,000
  rows at **113–120 ms**, 5× the `<->` figure.
- **Threshold sensitivity is severe.** One query matched **48 rows at the default 0.3, 4 at
  0.5, and 1,037 at 0.15**.
- **It is 350× slower than the cheap column it sits behind.** The folded-column exact hit
  is **0.059 ms**; determining a miss is **0.013 ms**.

**And it finds the right card**, which is the honest reason to like it — six of seven real
misspellings of real names correct at rank 1: `lighming bolt` → **Lightning Bolt**,
`farfetchd` → **Farfetch'd**, `kozuki oden` → **Kouzuki Oden**, `bell mere` →
**Bell-mère**, `kaisa` → **Kai'Sa**, `flabebe` → **Flabébé**. That is the best correctness
measured anywhere on this ticket. (`sheldred` → Sheoldred missed at rank 1.)

## Why the corpus is real names, not #19's

Trigram index selectivity is driven **entirely** by name vocabulary. #19's generated corpus
has 533 distinct terms and cannot answer a `pg_trgm` question — `spike/d1-trigram/`
measured the same query costing 5.5× more on it. This spike uses the 38,001 real card
names collected in [`spike/typo-search/`](../typo-search/), cycled to 150,000 Printings the
way a real Catalogue repeats a name across sets, variations, finishes and languages.

It also carries the folded name column measured in `spike/typo-search/`, because the
comparison that matters is similarity-with-LIMIT against **the cheap column**, not against
nothing.

## Run it

Needs Docker. Nothing hosted, nothing provisioned, no account, no money.

```sh
node gen.mjs   # writes data/printings.tsv (~6 MB, gitignored)
./run.sh       # postgres:17-alpine, COPY, indexes, EXPLAIN (ANALYZE, BUFFERS)
docker rm -f shopkeepr-pgtrgm-spike
```

`run.sh` leaves the container up so `probes.sql` can be re-run against it:

```sh
docker exec -i shopkeepr-pgtrgm-spike psql -U postgres -d shopkeepr -f - < probes.sql
```

## What it cannot answer

**The number that would actually decide #24: Worker-to-provider wall-clock.** Every figure
here is server-side, warm, single-client, local — as are the D1 figures it is compared
against. Neither includes a network, and the Postgres case turns on the network.

Settling it needs a hosted database (Neon, PlanetScale Postgres, or anything behind
Hyperdrive) and a deployed Worker, which this ticket's ground rules forbid provisioning.
**#19, #20 and now #25 have all left this gap.** Cloudflare's published 500 ms uncached /
320 ms cached Hyperdrive figures are cross-region and are deliberately not substituted for
a measurement.
