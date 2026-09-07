# Spike: libSQL / Turso engine capabilities

**Throwaway spike, not app code.** It exists to answer
[issue #18](https://github.com/KeeprDigital/shop-keepr/issues/18): does libSQL/Turso remove the
limits `docs/research/2026-09-07-d1-search-capabilities.md` measured on D1? (That document and
`spike/d1-search/` live on branch `research/d1-search`, not yet merged.)

Findings: [`docs/research/2026-09-07-libsql-turso-eval.md`](../../docs/research/2026-09-07-libsql-turso-eval.md).

## What it does

Runs the **same capability matrix** the D1 spike ran, against the two engines Turso Cloud
offers, so the three columns are directly comparable:

- `probe-libsql.mjs` — libSQL (`@libsql/client@0.18.0`, the SQLite fork), local file.
- `fts5-libsql.mjs` — libSQL FTS5 ranking and highlighting: `bm25()`, `rank`, `snippet()`,
  `highlight()`, prefix and phrase queries.
- `run-turso-probes.sh` + `probe-turso-one.mjs` + `ceilings-turso.mjs` — Turso Database
  (`@tursodatabase/database@0.7.2`, the Rust rewrite), local file.
- `holds.mjs` — re-runs [#4](https://github.com/KeeprDigital/shop-keepr/issues/4)'s oversell
  scenario against libSQL three ways: naive read-then-write (negative control), an
  **interactive transaction** (the thing D1 cannot do), and D1's single conditional statement.

```bash
cd spike/turso-eval
npm install
npm run probe:libsql
npm run probe:fts5
npm run probe:turso
npm run holds
```

## What it proves, and what it does not

**Proves:** what each *engine* accepts. `no such module: fts5` on Turso Database is a property
of the engine, and it is the same engine Turso Cloud runs.

**Does not prove:** anything about **Turso Cloud the service**. Cloud imposes its own limits,
its own latency (every query is an HTTP request from a Cloudflare colo to an AWS region), and
its own quota enforcement. Row counts and wall-clock times here are in-process and meaningless
for a hosted database.

This is the same boundary the D1 spikes drew between local `workerd` and real D1, and it is
left open for the same reason: **no remote resources were provisioned, no account was created,
no money was spent.** See "What remains unverified" in the findings document.

## Note on `run-turso-probes.sh`

Each probe runs in its own process because Turso Database **segfaults** (exit 139, no output)
on a 5,000-term compound `SELECT`. Reproduced 3/3. libSQL rejects the same input cleanly with
`too many terms in compound SELECT`. A 5,000-term compound `SELECT` is not a query shop-keepr
would write; it is recorded as a maturity signal, not a workload risk.
