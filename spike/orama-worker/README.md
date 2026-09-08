# Spike: does Orama fit inside a Worker at 150k Printings?

**Throwaway spike, not app code.** Item 3 of
[issue #25](https://github.com/KeeprDigital/shop-keepr/issues/25). Findings live in
[`docs/research/2026-09-08-typo-tolerant-search-options.md`](../../docs/research/2026-09-08-typo-tolerant-search-options.md).

## The question

[#24](https://github.com/KeeprDigital/shop-keepr/issues/24) calls Orama *"genuinely
non-obvious and worth costing"* and #25 calls it *"the highest-variance option on the
list: no network hop at all if it works, dead on arrival if it does not fit."* Does a
150,000-record typo-tolerant index load and run inside a Worker's memory and CPU limits?

## The answer: it runs, and it does not fit

**It runs.** Orama's `browser` build executes unmodified inside real workerd — no Node
built-ins, no polyfills — building 150,000 documents in **989 ms** and searching in
**6 ms**. Its npm `exports` map has `deno`, `browser`, `import` and `require` conditions
and **no `worker` condition**; Workers resolves `browser`. Cloudflare Workers is never
named in Orama's README or docs.

**It does not fit.** Measured in Node, heap after an explicit GC:

| Documents | Schema | Settled heap | `persist('json')` |
| ---: | --- | ---: | ---: |
| 38,001 | name only | 47 MB | 9.0 MB |
| 50,000 | + game, rarity, `sellPrice`, `quantity` | **83 MB** | 20.0 MB |
| 100,000 | + filters | 128 MB | 36.1 MB |
| **150,000** | **+ filters** | **184 MB** | **53.2 MB** |

Cloudflare documents **128 MB per isolate**, and states the limit is *per isolate, not per
invocation* — the same isolate serves concurrent requests **and the rest of the Nuxt
application**. 184 MB is not a near miss.

Three further hard blocks:

- **Restore is worse than build**: 454 ms and a **320 MB peak heap**, settling to 196 MB.
- **The index does not fit in KV.** KV caps a value at **25 MiB**; the index is 53.2 MB.
  R2 or a bundled asset are the only options. #25 raised this as an open question.
- **Only one serialisation format works.** `persist(db, 'binary')` fails at 150k with
  `Too deep objects in depth 101`; `'dpack'` fails with `"length" is outside of buffer
  bounds`. `'json'` also threw `RangeError: Maximum call stack size exceeded` when several
  indexes were built in one process, and succeeded at every size in a fresh process — the
  failure is heap-state-dependent, not size-dependent. `persistToFile`/`restoreFromFile`
  use filesystem APIs and are unusable in a Worker regardless.

**Where it fits: roughly 50,000 documents with filters, at 83 MB.** A third of the corpus,
and there is no natural way to cut a Catalogue to a third.

## Its typo tolerance is the weakest measured

Same error classes as [`spike/typo-search/`](../typo-search/), so the numbers sit in the
same table as the cheap columns and `pg_trgm`. Recall@1:

| Class | `tolerance: 1` | `tolerance: 2` |
| --- | ---: | ---: |
| **transposition** | **0%** | 68% |
| dropped diacritic | 43% | 45% |
| straight → curly `’` | **16%** | 12% |
| deletion | 81% | 62% |
| QWERTY slip | 79% | 72% |

- **`tolerance: 1` scores 0% on transpositions**, the measured consequence of Orama
  documenting *"the Levenshtein algorithm … insertions, deletions or substitutions"* —
  plain Levenshtein, where a transposition costs 2 edits.
- **Accents 43% and smart quotes 16%.** Orama does not reliably normalise either, so a
  folded name column is needed **even with** a typo-tolerant engine.
- **No single setting is good.** `tolerance: 2` halves partial-recall precision and costs
  4–13 ms against 1 ms. `threshold: 0` is mandatory — the default OR-of-tokens returned
  105 hits for `Lightning Bolt` with `Boltbender` ranked first.

## Run it

```sh
cd spike/orama-worker && npm install

node --max-old-space-size=8192 --expose-gc size-one.mjs 150000 filters  # one size per process
node --max-old-space-size=8192 build-index.mjs      # build + persist all three formats
node --max-old-space-size=8192 --expose-gc restore-cost.mjs  # the cold-start question
node --max-old-space-size=8192 recall.mjs           # typo-tolerance quality
node search-tune.mjs                                # threshold / tolerance sweep

# and inside real workerd, from the repo root:
node_modules/.bin/vitest run --config spike/orama-worker/vitest.config.ts \
  --reporter=verbose --disable-console-intercept
```

## What it cannot answer

**`@cloudflare/vitest-pool-workers` does not enforce the production 128 MB isolate limit**,
so the workerd run proves the *code* is compatible and does not prove the memory verdict.
The memory verdict rests on Node's `heapUsed` compared against Cloudflare's documented
ceiling. Confirming it would need a deployed Worker, which this ticket's ground rules
forbid — but the margin (184 MB against 128 MB, with a 320 MB restore peak) is large
enough that the conclusion does not turn on the measurement method.

Also not measured: whether streaming the index from R2 rather than bundling it changes the
peak. It cannot help enough — the settled heap alone exceeds the ceiling.
