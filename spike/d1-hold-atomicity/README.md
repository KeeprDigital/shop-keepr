# Spike: D1 hold atomicity

**Throwaway spike, not app code.** It exists to answer one question for
[issue #4](https://github.com/KeeprDigital/shop-keepr/issues/4), and it is kept on `main` only because
that issue's resolution records an obligation this harness makes cheap to discharge.

## The question

Can a stock reservation be made atomically on D1 — which has no interactive
transactions — using a *single* SQL statement, so that no Durable Object is
needed as a serialisation point?

## The answer

**Yes, on local D1.** 16,250 reservation attempts across 400 scenario
iterations, zero oversell. Concurrency 2/10/50/200 via the direct binding, plus
25-way concurrent HTTP and 25-way concurrent `.batch()`.

The result is credible because of the **negative control** in `reserve.test.ts`:
the naive JS read-then-write overselled *maximally* — all 25 racers winning, in
50 of 50 iterations — under the identical harness. So the harness genuinely
interleaves, and the passing result is not an artefact of a test that never raced.

## The outstanding obligation

> [!NOTE]
> **Discharged 2026-09-10 by [#17](https://github.com/KeeprDigital/shop-keepr/issues/17).** Re-run against a real D1 database from a deployed Worker: 16,250 attempts, **zero oversell**, negative control overselling maximally, every `batch()` case reproducing. A single reserve statement costs 34 ms wall (0.26 ms in D1, 11 `rows_read`). See [`spike/d1-remote/`](../d1-remote/README.md).

**This ran on local workerd/miniflare only.** `wrangler d1 create` was
unavailable to the agent, so remote D1 is unverified.

The mechanism should transfer — the naive version fails specifically because of a
JS `await` between the read and the write, and the single statement contains no
JS turn — but **re-run the core oversell measurement against a real D1 database
before trusting this in production.** That is what this directory is preserved for.

```bash
pnpm install
pnpm vitest run --config spike/d1-hold-atomicity/vitest.config.ts
```

To verify remotely, create a real D1 database, point `wrangler.jsonc` at it, and
re-run the concurrency scenarios against it rather than the local binding.

## The finding that changes app code

**`.batch()` gives atomicity but NOT conditionality.** A follow-on statement still
runs even when the conditional insert inserted nothing — observed as
`hold changes=0` with `on_hand` decremented anyway, i.e. silent inventory
corruption. Every dependent statement must carry the condition in SQL:

```sql
AND EXISTS (SELECT 1 FROM hold WHERE basket_id = ?)
```

This is verified working in the tests, and is a requirement on the real
implementation, not a curiosity.
