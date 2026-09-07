# Research: Postgres on Workers, re-examined

- **Issue:** [#19](https://github.com/KeeprDigital/shop-keepr/issues/19) (re-examines [#2](https://github.com/KeeprDigital/shop-keepr/issues/2), map [#1](https://github.com/KeeprDigital/shop-keepr/issues/1))
- **Date:** 2026-09-07
- **Status:** resolved
- **Re-examines:** [`2026-09-07-cloudflare-data-layer.md`](./2026-09-07-cloudflare-data-layer.md) (the D1 decision on #2)
- **Compares against:** [`2026-09-07-d1-search-capabilities.md`](./2026-09-07-d1-search-capabilities.md) (the measured D1 behaviour, on branch `research/d1-search`)
- **Spike:** [`spike/postgres-fts/`](../../spike/postgres-fts/). Every Postgres number below comes from it.

Documentation claims were fetched live from primary sources on 2026-09-07. Postgres measurements were taken the same day on PostgreSQL 17.11 in Docker, against **the same 150,000-row corpus the D1 search spike measured** — same generator, same PRNG seeds, same word stock, same counts. Anything that could not be settled without a hosted database is marked as an **obligation**, not inferred.

---

## Verdict

**#2's rejection stands, and all three of its footguns are still true verbatim. But it stands on a narrower base than #2 claimed, and the measurements make the cost of standing by it larger than #2 knew.**

| #19 asks                                                           | Answer                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1. Query caching on by default, no write invalidation?             | **Still true, word for word.** One change since, and it does not help.                                                             |
| 2. Hyperdrive absent under `wrangler dev`?                         | **Still true, word for word.**                                                                                                     |
| 3. No `LISTEN`/`NOTIFY`?                                           | **Still true** — and now shown to be true on _every_ path, not just Hyperdrive's.                                                  |
| 4. Nitro bug status?                                               | **Still open.** Triaged 5 days ago, not fixed. But #2 over-weighted it — see [below](#4-the-nitro-bug-is-the-weakest-of-the-four). |
| 5. Non-Hyperdrive paths?                                           | **Real, and they do avoid footguns 1 and 2** — each by surrendering something else. A trilemma #2 never saw.                       |
| 6. Is Postgres full-text competitive with FTS5's 1–6 ms / 39 rows? | **Yes, server-side. 0.07–5.9 ms on the identical corpus.** The comparison that decides the question is not this one.               |
| 7. Migration effort against what now exists?                       | **Zero. There is no data layer in the repo yet.** #2's "roughly a day" is untestable and, right now, moot.                         |

Two of #2's supporting arguments should be **downgraded**: the Nitro bug, and "a second vendor and bill". Two things #2 did not know should be **added to D1's cost**: the empty-facet tail is a SQLite-planner limitation Postgres does not have, and D1's search index can go silently stale where Postgres's structurally cannot.

---

## 1–3: the three footguns, re-verified

All three re-fetched from the pages #2 cited. Quotes are verbatim from the current pages.

### Footgun 1: query caching, on by default, no write invalidation — **unchanged**

[hyperdrive/concepts/query-caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/), page last updated **2026-07-05** (i.e. it has been edited since #2's sources were written, and these sentences survived):

> "Query caching is enabled by default."

> "Hyperdrive does not purge or invalidate cached read query results when your application writes to your database."

Defaults are still `max_age` 60 s and `stale_while_revalidate` 15 s, maximum configurable `max_age` 1 hour. The only documented control is still `--caching-disabled`, per configuration, at create or update time.

**One thing moved, and it does not help.** The Hyperdrive changelog carries an entry dated **2026-02-23**, _"Hyperdrive no longer caches queries using STABLE PostgreSQL functions"_, which widens the set of queries treated as uncacheable beyond the `VOLATILE` list #2 recorded. That narrows the cache; it does not add invalidation. The query this app actually cares about — `SELECT … FROM stock WHERE store_id = $1 AND …` — contains no volatile or stable function, so it is cached, and the 60-second stale-stock window #2 described is exactly as wide as #2 said.

**#2 left an item unverified; it is now settled as a negative.** #2 said the flags to _tune_ `max_age`/`stale_while_revalidate` "were not surfaced". Re-checked: the page documents no such flag. `--caching-disabled` is all there is, and cache-key composition remains undocumented, as does any per-query bypass. The only documented pattern for mixing fresh and cached reads is **two Hyperdrive configurations**.

### Footgun 2: no Hyperdrive under `wrangler dev` — **unchanged**

[hyperdrive/configuration/local-development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/), page last updated 2026-04-21:

> "When using `localConnectionString`, Hyperdrive's connection pooling and query caching do not take effect."

> "Your Worker connects directly to the database without going through Hyperdrive."

> "Hyperdrive query caching does not take effect in this mode."

`wrangler dev --remote` is documented as the mode where _"Hyperdrive's connection pooling and query caching are active"_.

**A near-miss worth naming.** The changelog entry of **2025-12-04**, _"Connect to remote databases during local development with `wrangler dev`"_, sounds like this was fixed. It was not. It lets `localConnectionString` point at a _remote_ database; the connection still bypasses Hyperdrive. The divergence #2 objected to — that local dev cannot reproduce the stale-cache bug class — is untouched.

### Footgun 3: no `LISTEN`/`NOTIFY` — **unchanged, and now known to be unavoidable**

[hyperdrive/reference/supported-databases-and-features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/), page last updated 2026-04-21, unsupported list verbatim:

> "SQL-level management of prepared statements, such as using `PREPARE`, `DISCARD`, `DEALLOCATE`, or `EXECUTE`."
> "Advisory locks"
> "`LISTEN` and `NOTIFY`."
> "Any modification to per-session state not explicitly documented as supported elsewhere."

Supported Postgres versions are still 9.0–17.x. `COPY` and cursors are still not addressed on the page, so their status remains **undocumented**.

**#2 assumed this was a Hyperdrive limitation. It is stronger than that** — the escape hatch #2 named ("set up a second, direct client without Hyperdrive") does not actually deliver change notification either, on any path. Reasons, each from a primary source:

- **Direct TCP.** [workers/runtime-apis/tcp-sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): sockets must be created _"within a handler"_ and _"cannot be created in global scope and shared across requests"_. A `LISTEN` that dies with the request notifies nobody.
- **From a Durable Object.** Same page: _"When created from within a Durable Object, an open TCP socket keeps the Durable Object in memory and causes it to incur duration charges for up to 15 minutes per connection."_ So it is possible — at the price of a permanently-resident, billed Durable Object holding a Postgres connection. You have then built the Durable Object you were trying to avoid, _and_ added a database connection it must keep alive.
- **Neon's serverless driver.** [Neon serverless driver docs](https://neon.com/docs/serverless/serverless-driver), verbatim: _"WebSocket connections can't outlive a single request. That means `Pool` or `Client` objects must be connected, used and closed within a single request handler."_

**Conclusion, unchanged from #2 but now properly evidenced: realtime needs a Durable Object regardless of the database.** The realtime mechanism does not discriminate between D1 and Postgres. #4's design is unaffected either way.

### 4: the Nitro bug is the weakest of the four

[nitrojs/nitro#3893](https://github.com/nitrojs/nitro/issues/3893) is **still open**. Created 2025-12-22, 6 comments, last comment 2026-06-04. It moved once since #2 was written: on **2026-09-02** the `pending triage` label was replaced with `bug` + `v3` — so a maintainer has confirmed it as a bug, and has not fixed it.

**But #2 leaned on it harder than the evidence supports, and this re-examination should say so.**

- The failure is in Nitro's experimental `useDatabase()` / `db0` layer, which caches a database object in module scope ([`src/runtime/internal/database.ts`](https://github.com/nitrojs/nitro/blob/0f3740dfe28f4e60f13cbd2be8bfa477669e3aa5/src/runtime/internal/database.ts#L5-L17), identified in-thread by the reporter). Nitro maintainer `pi0` in-thread: _"yes it is my guess too"_ on Workers global scope being the cause.
- The reporter's own workaround — creating the connection from the Hyperdrive binding directly — _"works 100% of the time"_.
- A later commenter (2026-06-04) reports the same error connecting a `pg` `Pool` directly to Hyperdrive, and reasons that _"Hyperdrive is already does pooling and doing manual pooling application-side would conflict"_. That is a pooling-on-pooling misuse, not a Nitro defect.
- **shop-keepr does not use `useDatabase()` and has no reason to.** The repo does not depend on `db0` or Drizzle at all (see [§7](#7-migration-effort--there-is-nothing-to-migrate)), and the D1 plan in #2 also bypasses `useDatabase()` in favour of `drizzle(env.DB)` on a binding.

So this is an argument against `useDatabase()`, which nothing here proposes using. It should stop being cited as a reason not to use Postgres. The three real footguns carry the decision on their own.

---

## 5: the non-Hyperdrive paths — a trilemma #2 never saw

Cloudflare documents three ways for a Worker to reach Postgres ([workers/databases/connecting-to-databases](https://developers.cloudflare.com/workers/databases/connecting-to-databases/)). #2 evaluated one.

|                                  | Hyperdrive                                    | Direct TCP (`connect()`)               | HTTP driver (Neon / Prisma)      |
| -------------------------------- | --------------------------------------------- | -------------------------------------- | -------------------------------- |
| Footgun 1 (cache)                | **Present**                                   | Absent                                 | Absent                           |
| Footgun 2 (local dev divergence) | **Present**                                   | Absent — same path locally and in prod | Absent — it is `fetch`           |
| Footgun 3 (`LISTEN`/`NOTIFY`)    | Absent                                        | Absent (socket dies with the request)  | Absent                           |
| Connection setup                 | Pooled near origin; 1 cross-region round trip | **7 round trips, every request**       | 1 HTTPS request                  |
| Interactive transactions         | Yes, documented as a scaling hazard           | Yes                                    | **No** (HTTP is one-shot)        |
| Cloudflare's own guidance        | "recommended"                                 | "should use Hyperdrive"                | "Hyperdrive (recommended), or …" |

**The trilemma: every path drops one of the three things Postgres was supposed to buy.**

- **Hyperdrive** buys pooled latency and interactive transactions, and costs you the stale-read hazard and a local dev environment that cannot reproduce it.
- **Direct TCP** removes both footguns exactly — there is no cache to go stale and no Hyperdrive to be missing locally — and costs you the pooling. [connection-lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/) prices it verbatim: _"the TCP handshake (1x), TLS negotiation (3x), and database authentication (3x)"_, seven round trips, and the TCP sockets page forbids amortising them across requests. Cloudflare's own summary on the connecting-to-databases page is that direct connections require _"multiple roundtrips to establish a secure connection before a query"_. This is the worst option for a kiosk.
- **HTTP drivers** remove both footguns _and_ the handshake — one `fetch`, no pool, identical under `wrangler dev` because it is just HTTP — and cost you interactive transactions. Neon's driver over HTTP is documented for _"single, non-interactive transactions, also referred to as 'one-shot queries'"_, with batching _"within a single, non-interactive transaction"_; anything session-scoped requires the WebSocket mode, which cannot outlive a request. Prisma Postgres connects the same way: _"connect from Cloudflare Workers, Vercel Edge Functions, and other edge runtimes via the serverless driver, which uses HTTP instead of TCP."_

**The sharp consequence.** The one path that cleanly avoids footguns 1 and 2 — an HTTP driver — offers **exactly D1's transaction model**: atomic batches, no interactive transactions. And "interactive transactions" is the headline entry on #19's own list of what Postgres would buy. On that path it evaporates. You would be paying a second vendor for D1's transaction semantics.

**Supabase** ([connecting-to-postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)) offers a third shape: the Supavisor transaction-mode pooler, _"ideal for serverless or edge functions, which require many transient connections"_, and _"IPv4-only on every project tier"_. Session state does not survive there either, so it has Hyperdrive's session semantics without Hyperdrive's cache. Its Data API (PostgREST) is an HTTP path with the HTTP path's limits. Note both Cloudflare provider guides insist on the **direct, non-pooled** connection string when Hyperdrive _is_ used, and on `pg`/`postgres.js` rather than the vendor's own client — so the vendor-native HTTP driver and Hyperdrive are alternatives, never a stack.

**Vendor lock, honestly.** The HTTP path is the _most_ locked-in of the three: `@neondatabase/serverless` and Prisma's driver speak to one vendor's endpoint, not to Postgres. Hyperdrive and direct TCP both speak the Postgres wire protocol to anything. So the option that best avoids #2's footguns is also the one that most undermines #2's stated consolation prize — _"a portable, boring database you could move off Cloudflare entirely."_

---

## 6: is Postgres full-text competitive at 150k rows?

**Server-side, yes — comfortably, and it wins the case that matters most. That is not the comparison that decides the question.**

### Method, and the one thing that makes this honest

The spike loads the **identical corpus** the D1 spike measured: `spike/postgres-fts/gen.mjs` is a plain-JS port of `spike/d1-search/seed.ts` with the same `mulberry32` seeds (`0x5EED1234`, `0xF00D9876`), the same word lists, the same 110k/20k/13k/4k/3k split and the same two stores at 4,000 and 60,000 SKUs. It independently counts **533 distinct terms** over the indexed fields against the D1 spike's 534 FTS5 terms, which is the corpus identity check.

The schema is a column-for-column transliteration, _including_ the two disciplines #2 adopted specifically to keep this port cheap: money as integer minor units, timestamps as epoch-ms integers. No `NUMERIC`, no `timestamptz`. The point is to measure the port that would actually be made.

Full text is a `GENERATED ALWAYS AS (to_tsvector('simple', name || set_name || type_line)) STORED` column with a GIN index. `simple`, not `english`, because FTS5's default `unicode61` tokenizer does not stem; using a stemmer here would be measuring a different thing.

**Two caveats, stated before the numbers.** First, the units do not match: D1 reports `rows_read`, Postgres reports 8 KB buffer blocks. They are not convertible, and no ratio between them means anything. Both are shown because each is the cost signal its own engine actually exposes. Second, both sets of figures are **server-side and warm** — the D1 numbers came from in-process workerd/miniflare, the Postgres numbers from a local container. Neither includes a network.

### The numbers

| Query                                          |  D1 median | D1 `rows_read` |    PG median | PG blocks |
| ---------------------------------------------- | ---------: | -------------: | -----------: | --------: |
| FTS single token (`sentinel`)                  |       4 ms |             39 |       5.9 ms |    16,159 |
| FTS two tokens                                 |       1 ms |             39 |       1.5 ms |     2,188 |
| FTS prefix (`sent*` / `sent:*`)                |       5 ms |             39 |  **0.07 ms** |       269 |
| FTS phrase                                     |       2 ms |             39 |       1.3 ms |       446 |
| FTS + game facet + join to stock, price-sorted |       6 ms |         20,194 |   **1.6 ms** |     7,180 |
| Substring (`%entine%`)                         |  **<1 ms** |             19 |       3.3 ms |     8,116 |
| Prefix `LIKE`, correct index                   |      <1 ms |            238 |      0.33 ms |       810 |
| Faceted browse                                 |       1 ms |          1,146 |       1.5 ms |     2,537 |
| Facet count                                    |      <1 ms |          2,713 |       1.5 ms |     4,465 |
| Faceted in-stock, 4k-SKU store                 |       5 ms |          6,042 |       2.5 ms |     9,247 |
| Faceted in-stock, 60k-SKU store                |       7 ms |          6,513 |       7.9 ms |    50,500 |
| Empty facet, 4k-SKU store                      |       6 ms |          7,510 |      0.05 ms |       458 |
| **Empty facet, 60k-SKU store**                 | **109 ms** |    **112,803** | **0.047 ms** |   **458** |
| Multi-select facets                            |      10 ms |         27,543 |       0.9 ms |     1,619 |
| Deep pagination (`OFFSET 2000`)                |      24 ms |         34,587 |       2.8 ms |     6,645 |

Answer to #19's headline question: **1–6 ms on D1 against 0.07–5.9 ms on Postgres.** Full-text is a tie on the common cases. Nothing here would justify a move on search speed alone.

### Where Postgres genuinely wins, and why

**The bad tail. 109 ms → 0.047 ms, and the reason is the planner, not the schema.**

This is the single most important measurement in this document. The D1 spike's worst result was a selective facet against a 60k-SKU store reading the store out — 112,803 rows to return zero — because SQLite drove the price-ordered scan from `stock` and could not stop early. Postgres, on identical data and an identical query, produced:

```
->  Index Scan using cp_game_colour on catalogue_printing p  (actual time=0.012..0.012 rows=0 loops=1)
      Index Cond: ((game_system = 'yugioh') AND (colour_identity = 'WUBRG') AND (rarity = 'secret-rare'))
->  Index Scan using stock_printing on stock s  (never executed)
```

`never executed`. The cost-based planner's statistics told it the catalogue side would return ~7 rows, so it drove from there and never touched `stock` at all. It also _switches strategy by selectivity_: for the common facet it chose a hash join, for the empty facet a nested loop.

**This matters beyond the one number.** #13's remedy for the D1 tail was to denormalise the Catalogue's facet columns onto the store-owned `stock` table — "a second derived read model, fed by the same sync". That denormalisation is not paying for a data-model problem. It is **buying back a query planner**, and it cuts against #6's clean ownership split to do so. That is a real, now-quantified cost of D1 that #2 could not have known and #13 recorded as a checklist item rather than a trade.

**The search index cannot go stale.** #13 called an out-of-date search index "the worst failure this system has", and proved D1's external-content FTS5 index _does_ silently diverge from its base table on a rename. Measured here on the same operation: after renaming a row, the new term matched (1 row) and the stale term matched **0** rows. A `GENERATED … STORED` column is written by the same statement that writes the row; there is no trigger to forget. #13's mandatory-trigger-discipline constraint disappears rather than being satisfied.

**`pg_dump` works with a full-text index present.** Verified: schema-only dump 203 lines, full custom-format dump 7.9 MB, both with the GIN indexes in place. Against D1, where verbatim _"Export is not supported for virtual tables, including databases with virtual tables"_ — and because #6's constraint 1 forces the ledger to share the database with the mirror, an FTS5 table removes `wrangler d1 export` **for the ledger too**.

**Limits that stop being limits.** A 20,000-element parameter array executed without complaint, against D1's hard cap of exactly 100 — which is why the D1 spike found a bulk seed _must_ inline escaped SQL literals. A 10-term `UNION ALL` ran, against D1's undocumented 5-term compound-`SELECT` cap that "kills any multi-select facet implemented as a `UNION`". A `BEGIN` / `SELECT … FOR UPDATE` / `UPDATE` / `COMMIT` round trip took 2.3 ms total — the read-then-decide-then-write that D1 structurally cannot do.

**On #19's "65535-parameter limit" figure, a correction.** The primary source is the wire protocol, not a server setting: [protocol-message-formats](https://www.postgresql.org/docs/17/protocol-message-formats.html) defines the Bind message's parameter count as **`Int16`**. 65,535 is what drivers enforce by reading that field as unsigned; the signed reading gives 32,767. Either way it is two to three orders of magnitude above D1's 100, so the argument is unaffected — but the number should be quoted as a driver-level figure, not a documented Postgres limit.

### Where D1 wins, and it is not nothing

**Substring search: FTS5's trigram tokenizer beat `pg_trgm` here, 3× on time.** `<1 ms` and 19 rows read on D1, against 3.3 ms on Postgres — and the Postgres planner **did not use the trigram index**. With `ORDER BY name LIMIT 20` it preferred an ordered scan of `cp_name` with a filter, discarding 3,921 rows. Probed further: without the `ORDER BY` it chose a sequential scan; forced to count all matches it used `cp_name` again, taking 38.8 ms. The `cp_name_trgm` GIN index was only chosen when it was the _only_ usable index, and it cost 11–13 MB — the largest index in the database, larger than the primary key.

This is not a Postgres defect so much as a warning that the substring path needs deliberate work on either engine. But the naive version is faster on D1, and #13's advice to keep a separate trigram index is more reliably rewarded there.

**Storage is a wash, with a surprise inside.** D1's searchable mirror measured 96.2 MB; the Postgres equivalent is 87 MB for the printing table and its indexes, 107 MB for the whole database including both stores. Underneath, the mix is very different: FTS5's index cost D1 ~24.5 MB, while the **tsvector GIN index is 3.3 MB** — the tsvector values themselves live in the 40 MB heap. Against Postgres's absence of a 10 GB ceiling this is academic in both directions.

**Write cost is materially higher for a name change.** A 2,000-row market-price delta (no indexed text touched) took 68 ms. The same 2,000 rows with a `name` change — which rewrites the generated tsvector and both GIN indexes — took **91 ms** and dirtied noticeably more. D1's comparable figure was 4,000 `rows_written` for a 2,000-row price delta. The units differ again, but the shape is the same: text changes are the expensive ones on both engines.

### The comparison that actually decides it, and which nobody has run

**Every number above, on both sides, excludes the network. The entire Postgres question is the network.**

D1's hop stays inside Cloudflare's network and takes a location hint. Postgres's does not. The only figures Cloudflare publishes are from [its own Hyperdrive benchmark](https://blog.cloudflare.com/how-hyperdrive-speeds-up-database-access/) — database in London, Worker in Chicago:

- direct connection ≈ **1200 ms**
- Hyperdrive, uncached ≈ **500 ms**
- Hyperdrive, cached ≈ **320 ms**
- served from the client's own datacenter cache ≈ **4 ms**

Against those numbers, Postgres's 109 ms advantage on the empty-facet tail is **noise**. Cloudflare publishes no same-region or co-located uncached figure, and the connection-lifecycle page contains no cold/warm distinction and no first-request percentiles. So the decisive comparison is undocumented, and this spike cannot supply it: it would need a hosted Postgres and a deployed Worker, which the ground rules for this ticket forbid provisioning.

**That asymmetry is the finding.** Postgres wins every engine-level comparison that was measurable and loses the one that was not — by a margin large enough that the engine-level wins cannot recover it unless the co-located, uncached, warm-pool number turns out to be very much better than anything Cloudflare has published. **Recorded as an obligation, below.**

---

## 7: migration effort — there is nothing to migrate

Ticket #19 asks whether #2's "roughly a day" estimate survives contact with "what now exists — schema, spikes, and the Catalogue mirror".

**Checked against the repository at `main` (commit `25a49fd`): none of those things exist.**

- `package.json` has **no** `drizzle-orm`, no `db0`, no `pg`, no `postgres`, no `@cloudflare/workers-types` data dependency. `wrangler` is present as a devDependency only.
- There is **no `wrangler.jsonc` at the repository root**, so no D1 binding.
- There is no `server/` directory, no schema module, no migrations directory. `nuxt.config.ts` declares four UI/lint modules and nothing else.
- Everything data-shaped lives under `spike/` — `d1-hold-atomicity` and `d1-search` — and both are explicitly throwaway.
- The Catalogue mirror is a decision in #6, not code.

So the honest answer to #19's question 7 is that **the port cost today is zero**, and #2's day estimate is untestable because there is no application to test it against. The disciplines #2 adopted to keep the port cheap (integer minor units, epoch-ms timestamps) held up when transliterated — `schema.sql` in this spike is the D1 schema with `TEXT`/`INTEGER`/`BIGSERIAL` substitutions and nothing else — but they have so far only ever been applied to spike code.

**The consequence cuts toward re-deciding, not away from it.** The cheapest moment to change engines is now, and it will never be cheaper. If the D1 choice is being kept, it should be kept because the reasons are good, not because the switching cost has grown — it has not grown at all.

---

## What Postgres costs, concretely, for a solo operator

|                                | What you actually run                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neon**                       | Free: $0, **0.5 GB per project**, 100 CU-hours. The mirror alone measured 87–107 MB, so Free is workable but tight. **Scale-to-zero after 5 min, not disableable on Free.** Reactivation stacks on top of Hyperdrive's path — a warm pool does not wake a suspended compute. Launch is PAYG at $0.106/CU-hour + $0.35/GB-month.                                                   |
| **Supabase**                   | Free: $0, 500 MB, max 2 active projects, and verbatim **"Free projects are paused after 1 week of inactivity"** — a hard pause needing a restore, not a sub-second wake. Pro from **$25/mo**, 8 GB, no pausing.                                                                                                                                                                   |
| **PlanetScale via Cloudflare** | Postgres or MySQL, created from the Cloudflare dashboard/API and **billed to the Cloudflare account** since 2026-06-18. Same price as buying direct. No free tier surfaced, and verbatim: **"A PlanetScale database is billed daily from when the database is created until the database is deleted. Your database is billed whether or not you execute queries or store data."** |
| **Prisma Postgres**            | Free: 200k operations/month, 500 MB. Starter **$10/mo**. HTTP driver, Postgres 17, unikernel-based. Pausing/cold-start behaviour **not documented**.                                                                                                                                                                                                                              |
| **Hyperdrive itself**          | Free on both plans. 100,000 queries/day on Workers Free, unlimited on Paid. _"any query made through Hyperdrive, whether cached or uncached, whether query or mutation, is counted."_                                                                                                                                                                                             |

**"Second vendor and bill" needs downgrading — halfway.** #2 wrote the decision as "Cloudflare end-to-end", and the PlanetScale integration genuinely erodes the _billing_ half of that: one invoice, one account, provisioned by `wrangler`. It does not erode the operational half — it is still PlanetScale's dashboard, PlanetScale's status page, PlanetScale's upgrade cadence, PlanetScale's support boundary when something is slow at 4 pm on a Saturday in a shop. And it is the _worst_ of the four on cost floor, because it bills daily whether or not the shop is open.

**The realistic floor is unchanged from #2's:** a free tier that sleeps — reintroducing exactly the latency Hyperdrive exists to remove — or roughly $10–25/month. Against D1's zero marginal cost on a plan already being paid for.

**Ops burden, concretely.** Connection-limit tuning (`--origin-connection-limit`, soft, exceedable during network failure); a second migration runner (`drizzle-kit migrate` against a live database, versus `wrangler d1 migrations apply`); backups you configure rather than the 30-day minute-granularity Time Travel that D1 gives unasked; a second set of credentials in CI; `nodejs_compat`; and a documented instruction _not_ to wrap operations in a transaction because _"the connection cannot be reused by other Worker isolates for the duration of the transaction"_ — which quietly limits the interactive transactions that were the headline reason to want Postgres.

---

## Recommendation

**Keep D1. Do not reopen #2. But amend it, because two of its four arguments are weaker than written and D1's true cost is higher than it recorded.**

The rejection stands for reasons still true:

1. All three footguns re-verified verbatim, and none of the paths that dodge them dodges all three. The path that dodges the two worst — an HTTP driver — hands back interactive transactions, i.e. Postgres's headline advantage, leaving you paying a second vendor for D1's transaction model.
2. Realtime needs a Durable Object on every path. `LISTEN`/`NOTIFY` is not merely unsupported through Hyperdrive; it is unreachable from a Worker at all, and reachable from a Durable Object only by pinning it in memory at a documented billing cost.
3. The decisive latency comparison is undocumented and unmeasured, and the only published Cloudflare figures put an uncached cross-region query two orders of magnitude above every engine-level difference measured here.
4. Cost floor is a sleeping free tier or ~$10–25/month plus a second operational surface, against zero on a plan already paid for.

**Amend #2 with these four corrections:**

- **Stop citing the Nitro bug.** It is a `useDatabase()` defect in a code path this project does not use, with a workaround that works 100% of the time. It was never load-bearing and it should not be quoted as though it were.
- **Downgrade "second vendor and bill" to "second vendor".** PlanetScale Postgres has been billable through the Cloudflare account since 2026-06-18. The bill consolidates; the operational surface does not.
- **Record the empty-facet tail as a planner deficit, not a schema problem.** #13's denormalisation remedy is buying back a cost-based query planner that Postgres provides free, and it is the reason it cuts against #6's ownership split. Keep the remedy — it is right for D1 — but price it honestly on D1's side of the ledger.
- **Record FTS staleness as a standing D1 liability.** #13 calls a stale search index the worst failure this system has, and on D1 the only thing preventing it is trigger discipline the developer must not forget. Postgres removes the failure mode structurally. This is the strongest single argument the other way and #2 does not mention it.

**Revisit if and only if** one of these becomes true: the mirror plus ledger approaches the 10 GB ceiling; a second store makes cross-store reporting necessary (D1's cross-database prohibition is permanent); a read-then-decide-then-write requirement appears that atomic `batch()` cannot express; or a store's SKU count reaches five figures _and_ the denormalisation remedy proves insufficient in production.

---

## Obligations for the human

Neither this spike nor #13's may provision hosted resources, so the comparison that decides the question remains open. In priority order:

1. **Measure the real thing.** A deployed Worker against (a) a real D1 database and (b) a co-located hosted Postgres through Hyperdrive, running the load-bearing faceted in-stock query. This is the only number that matters and nobody has it. Cloudflare's published 500 ms uncached figure is cross-region (London↔Chicago); the same-region figure is undocumented.
2. **Measure a cold Hyperdrive path**, including a Neon compute waking from scale-to-zero. Neon documents reactivation as "a few hundred milliseconds"; the docs contain no cold/warm distinction for Hyperdrive itself.
3. **Confirm D1's remote behaviour** for the numbers this and #13's spike could only take locally: wall-clock latency, bulk-seed duration, and whether `rows_read`/`rows_written` are counted identically in production. Carried forward unchanged from #13 and #4 — this is now the **third** spike to leave it open.
4. **Verify an FTS5-bearing D1 database can be backed up in practice**, since `wrangler d1 export` is documented as unavailable and Time Travel is the only remaining path.
5. If the HTTP-driver path is ever seriously considered, **measure `@neondatabase/serverless` over HTTP from a deployed Worker**. Neon publishes no latency figure for it.

---

## What remains unverified

- **The Postgres figures are local-container, warm-cache, single-client.** No network, no concurrency, no other tenant, `shared_buffers=512MB` against a 107 MB database — so effectively everything is resident. A hosted instance under Hyperdrive will be slower, and by an unknown amount.
- **The corpus is generated**, carrying 533 distinct terms where a real trading-card catalogue would carry one to two orders of magnitude more. Both engines' full-text index sizes should be treated as floors. This affects D1 and Postgres identically, so the _comparison_ is sound even where the absolute sizes are not.
- **`COPY` and cursors through Hyperdrive** are addressed on no page fetched. Status genuinely unknown, not "probably fine".
- **Hyperdrive cache-key composition** and any per-query bypass remain undocumented.
- **PlanetScale-via-Cloudflare pausing / scale-to-zero behaviour** is not mentioned on either the changelog entry or the Hyperdrive PlanetScale page.
- **Prisma Postgres cold-start behaviour** is not documented.
- The `pg_trgm` planner result is one planner's choice on one corpus; a different selectivity or a different `ORDER BY` may well use the index. The finding is "it is not automatic", not "it never happens".

---

## Sources

Cloudflare (primary, all fetched 2026-09-07):

- [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) (page updated 2026-07-05) · [Local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/) (2026-04-21) · [Supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) (2026-04-21) · [Connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/) (2026-04-21) · [Connect to Postgres](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/) · [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) (2026-06-18) · [PlanetScale on Hyperdrive](https://developers.cloudflare.com/hyperdrive/planetscale/) · [Hyperdrive changelog](https://developers.cloudflare.com/changelog/rss/hyperdrive.xml)
- [TCP sockets (`connect()`)](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) · [Connecting to databases](https://developers.cloudflare.com/workers/databases/connecting-to-databases/) · [Neon third-party integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/) · [Postgres tutorial](https://developers.cloudflare.com/workers/tutorials/postgres/)
- [Changelog: PlanetScale databases billed to Cloudflare, 2026-06-18](https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/)
- [Blog: How Hyperdrive speeds up database access, 2025-04-08](https://blog.cloudflare.com/how-hyperdrive-speeds-up-database-access/) — the only published latency benchmark

Postgres and vendors (primary):

- [PostgreSQL 17 protocol message formats](https://www.postgresql.org/docs/17/protocol-message-formats.html) — the Bind message's `Int16` parameter count
- [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver) · [Neon pricing](https://neon.com/pricing) · [Supabase connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Supabase pricing](https://supabase.com/pricing) · [Prisma Postgres](https://www.prisma.io/docs/postgres) · [Prisma pricing](https://www.prisma.io/pricing)
- [nitrojs/nitro#3893](https://github.com/nitrojs/nitro/issues/3893), read via the GitHub API for label history and comment timestamps

Measurements:

- [`spike/postgres-fts/`](../../spike/postgres-fts/): `gen.mjs` (corpus, ported from `spike/d1-search/seed.ts`), `schema.sql`, `indexes.sql`, `queries/`, `probes.sql`, `run.sh`. Raw output in `data/results.txt` and `data/probes.txt`.
- D1 figures throughout are quoted from [`2026-09-07-d1-search-capabilities.md`](./2026-09-07-d1-search-capabilities.md) on branch `research/d1-search`, not re-measured here.
