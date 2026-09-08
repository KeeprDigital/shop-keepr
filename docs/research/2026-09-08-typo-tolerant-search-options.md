# Research: typo-tolerant search options for the Catalogue mirror on Cloudflare

- **Issue:** [#25](https://github.com/KeeprDigital/shop-keepr/issues/25) (successor decision [#24](https://github.com/KeeprDigital/shop-keepr/issues/24), map [#1](https://github.com/KeeprDigital/shop-keepr/issues/1))
- **Date:** 2026-09-08
- **Status:** resolved
- **Builds on:** [`2026-09-07-d1-search-capabilities.md`](./2026-09-07-d1-search-capabilities.md) (#13), [`2026-09-07-postgres-on-workers-reeval.md`](./2026-09-07-postgres-on-workers-reeval.md) (#19), [`2026-09-07-cloudflare-data-layer.md`](./2026-09-07-cloudflare-data-layer.md) (#2)
- **Spikes:** [`spike/typo-search/`](../../spike/typo-search/), [`spike/d1-trigram/`](../../spike/d1-trigram/), [`spike/pg-trgm-gist/`](../../spike/pg-trgm-gist/), [`spike/orama-worker/`](../../spike/orama-worker/). Every measured number below comes from one of them.

Documentation claims were fetched live from primary sources on 2026-09-08 and are dated in [Sources](#sources). Measurements were taken the same day on local workerd/miniflare, local Postgres 17.11 in Docker, and local Node 26. Where measurement and documentation conflict, the measurement is reported and the conflict is named. Anything that could not be settled is in [What remains unverified](#what-remains-unverified).

**One methodological change from the prior spikes, and it turned out to matter more than any single option.** #13 and #19 measured against a generated corpus with 534 distinct terms, and #13 flagged that as a limitation. This spike collected **38,001 real card names** from four primary sources and measured against those. For trigram work the difference is not cosmetic: the same query on the same schema read **1,391,435 rows on the generated corpus and 255,059 on the real one**, a 5.5× error in the pessimistic direction. #13's caveat is hereby a correction, and no trigram figure taken on the generated corpus should be quoted again.

---

## Verdict

| #   | Option                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Folded name column + Double Metaphone key | **The single biggest result on the ticket, and the ticket under-sells one half and over-sells the other.** _Two_ folded keys take every punctuation, accent and smart-quote failure to **100%** at a 0.20% collision cost. Double Metaphone is **not** typo tolerance — 22% on a keyboard slip — but it is 85–90% on phonetic and romanisation errors, which is exactly what it is for.                                                                           |
| 7   | What real typos look like                 | **The ticket's premise is measurably wrong in its headline claim.** Accents appear in **0.3%** of real card names. Punctuation appears in **21.6%**, and **88.8%** of names are multi-token. There is also a hazard class nobody named: **untypeable symbols** (δ, ◇, ★, ♀). "Mostly dropped accents" is false; "mostly punctuation and partial recall" is true.                                                                                                  |
| 1   | Postgres `pg_trgm` GiST + `<->`           | **Works. The planner uses the index under `ORDER BY … LIMIT`, and #19's finding does not generalise.** `Index Scan … Order By: (name <-> $1)`, 21 ms at 150k rows. But it is **350× slower than the folded-column hit (0.06 ms)** and the word-similarity operators fall back to a full parallel seq scan at **113–120 ms**. Worker-to-provider wall-clock remains **unmeasured and unmeasurable here**.                                                          |
| 2   | Hand-rolled trigram overlap on D1         | **Cheaper than #16 feared, and #16 measured the wrong table.** Its own shape reads **255,059 rows in 17 ms**, 2.3× #13's 113k tail. But indexing per _distinct name_ instead of per Printing — not considered by #16 — is **64,492 rows in 4 ms** for the same answer, at 27% of the storage. The fallback costs **0 rows read when it does not fire**.                                                                                                           |
| 3   | Orama inside a Worker                     | **Runs, does not fit.** The browser build executes unmodified in workerd (6 ms searches at 150k). But it holds **184 MB** of settled heap against a documented **128 MB per-isolate ceiling**, restore peaks at **320 MB**, and the 53.2 MB serialised index **exceeds KV's 25 MiB value limit**. Fits at roughly 50k documents, a third of the corpus. Typo ranking is also the weakest measured: plain Levenshtein, **0% on transpositions at `tolerance: 1`**. |
| 4   | Typesense / Meilisearch / Algolia         | **Typesense is the only one that dissolves the truncation problem without a structural penalty. Algolia is disqualified by its own documentation.** Details and pricing below; all documentation, none measured.                                                                                                                                                                                                                                                  |
| 5   | Search at the Catalogue                   | **card-keepr already has FTS5 search — the ticket and the map are both wrong that it has none — but it is the wrong search.** `GET /v1/cards?q=` is live, trigram-tokenised, and has **no ranking and no typo tolerance**. `/v1/printings` has no text index at all. A ranked endpoint was explicitly considered and closed (card-keepr#51).                                                                                                                      |

**What actually changes the decision on #24:** items 6 and 7 shrink the problem the engine has to solve, item 2 removes D1's disqualification, and item 3 removes Orama from the list. Those four together mean **#24 is no longer forced off D1 by the typo-tolerance requirement**. That is the headline.

---

## Item 7: what real card-name typos look like

### The corpus, and what it is not

Four Game Systems, 38,001 distinct real card names, all fetched 2026-09-08:

| Game System |  Names | Source                                              | Completeness                                                                       |
| ----------- | -----: | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Magic       | 35,077 | Scryfall `/catalog/card-names`                      | Complete                                                                           |
| Pokémon     |  1,599 | `api.pokemontcg.io/v2/cards?select=name`            | **Sample.** The unauthenticated endpoint rate-limits; 18 of 40 pages returned 200. |
| One Piece   |  1,170 | `en.onepiece-cardgame.com/cardlist/`, all 60 series | Complete (Bandai's own English list)                                               |
| Riftbound   |    173 | Riot Data Dragon `champion.json` 16.17.1            | **Proxy, not card names.** See below.                                              |

**The Riftbound figure is a proxy and must not be read as a Riftbound measurement.** No free Riftbound card list was reachable without registering for an API key, and this spike does not provision accounts. Riot's champion names are the proper-noun vocabulary Riftbound cards are built on, so they stand in for the _name shapes_ — `Kai'Sa`, `Cho'Gath`, `Rek'Sai`, `Nunu & Willump`, `Dr. Mundo`, `K'Sante`. Every Riftbound row below carries that caveat.

### Hazard frequency: the ticket's premise, measured

Share of distinct names carrying each hazard (`spike/typo-search/hazards.mjs`):

| Hazard                                  | Magic | Pokémon | One Piece | Riftbound* |                All |
| --------------------------------------- | ----: | ------: | --------: | ---------: | -----------------: |
| Combining marks after NFD (**accents**) |  0.3% |    1.2% |      0.1% |       0.0% |     **0.3%** (115) |
| Straight apostrophe `'`                 |  7.1% |    9.6% |      5.4% |       4.6% |   **7.1%** (2,709) |
| Curly apostrophe `’`                    |  0.0% |    0.0% |      0.1% |       0.0% |           0.0% (1) |
| Hyphen `-`                              |  4.1% |   10.0% |      7.9% |       0.0% |       4.5% (1,698) |
| Comma `,`                               |  9.3% |    0.0% |      0.6% |       0.0% |       8.6% (3,281) |
| Period `.`                              |  0.2% |    2.3% |      6.5% |       0.6% |         0.5% (173) |
| **Any punctuation**                     | 21.5% |   23.4% |     25.7% |       5.8% |  **21.6%** (8,215) |
| **Multi-token (≥ 2 words)**             | 92.4% |   42.7% |     54.2% |       6.4% | **88.8%** (33,737) |
| ≥ 4 tokens                              | 11.8% |    1.2% |     14.0% |       0.0% |      11.4% (4,316) |

**This contradicts the framing in #16, #24 and #25**, which all lead with _"card names carry accents, apostrophes, Japanese romanisations and invented proper nouns"_ in an order implying accents matter most. Across every non-ASCII character in all 38,001 names there are roughly **110 accented characters in total**: `é`×33, `û`×16, `ó`×11, `á`×11, `ú`×9, `í`×9, `ö`×7, `É`×6, and a tail of single occurrences. Scryfall has already normalised Magic's `Æther` cards to `Aether`, so the classic example is not even in the data.

Three corrections follow.

**Punctuation is the real hazard, at 70× the frequency of accents.** Commas (`Jace, the Mind Sculptor`), apostrophes (`Farfetch'd`, `Kai'Sa`, `Charlotte Mont-d'or`), hyphens (`Ho-Oh`, `Bell-mère`) and Bandai's periods (`Tony Tony.Chopper`, `Benn.Beckman`, `Bear.King`).

**A hazard class nobody named: characters a customer cannot type.** 100 names carry a symbol that is not on any keyboard — `δ` (81, Pokémon delta species: `Beedrill δ`), `◇`, `★`, `♡`, `♀`, `♂`, `®`. Someone searching for `Beedrill δ` types `Beedrill`. Folding must _delete_ these, not transliterate them, and the residue is a prefix problem rather than a normalisation problem.

**Multi-token any-order recall dwarfs everything.** 88.8% of names are multi-token and 11.4% run to four words or more. A customer types `mind sculptor`, not `Jace, the Mind Sculptor`. This is not typo tolerance and no amount of edit distance solves it — measured below, Damerau-Levenshtein ≤ 2 scores **2%** on it.

### Token length, and why it is a vendor-selection fact

Every hosted engine gates typo tolerance on word length. Measured over all 93,350 tokens:

| Corpus     | ≤ 3 chars | exactly 4 |   5–6 |   7–8 |    9+ |
| ---------- | --------: | --------: | ----: | ----: | ----: |
| Magic      |     16.8% |     11.5% | 30.2% | 24.0% | 17.4% |
| Pokémon    |     21.2% |      9.4% | 25.2% | 30.0% | 14.3% |
| One Piece  |     29.0% |     18.0% | 30.3% | 15.5% |  7.2% |
| Riftbound* |     14.6% |     18.2% | 43.2% | 19.3% |  4.7% |
| **All**    | **17.3%** | **11.7%** | 30.1% | 23.9% | 17.0% |

And the share of names that are _entirely_ one short token, which is the case that gets zero help:

| Corpus     | Whole name is one token of ≤ 4 chars | Examples                                               |
| ---------- | -----------------------------------: | ------------------------------------------------------ |
| Magic      |                                 0.3% | `Atog`, `Bant`, `Blur`                                 |
| Pokémon    |                                 1.3% | `Abra`, `Aron`, `Axew`, `Hop`                          |
| One Piece  |                             **7.3%** | `Adio`, `Ain`, `Aisa`, `Bepo`                          |
| Riftbound* |                            **20.8%** | `Ahri`, `Ashe`, `Azir`, `Ekko`, `Fizz`, `Gnar`, `Gwen` |

**Meilisearch's default gives no typo tolerance at all below 5 characters** (`minWordSizeForTypos.oneTypo` = 5). Typesense's `min_len_1typo` and Algolia's `minWordSizefor1Typo` are both 4, so a 4-character word gets one typo there and none on Meilisearch. For a store trading Riftbound and One Piece that is not a footnote: on Meilisearch defaults, one in five Riftbound proper nouns is exact-match-only. It is configurable in all three, but the default is wrong for this corpus.

### The error model, and its honest limits

**Nobody has a query log for this application, so no figure in this document is a frequency of real user behaviour.** What `spike/typo-search/misspellings.mjs` does is apply thirteen mechanically-defined error classes to real names. That makes the per-class recall numbers real measurements _of the mechanisms_; it makes the class **weights** an assumption. This document therefore reports per-class recall and **refuses to report a single weighted coverage number**, because that number would be invented. The unweighted mean in the table below is printed only so the columns can be compared, and is labelled as such in the spike output.

"Exposure" — how many of the 38,001 names can even suffer each class — _is_ measured, and it is the closest thing to a weight that exists:

| Class                          | Exposure |     | Class                            | Exposure |
| ------------------------------ | -------: | --- | -------------------------------- | -------: |
| A. dropped diacritic           |     0.3% |     | H. insertion (doubled letter)    |   100.0% |
| B. untypeable symbol dropped   |     0.3% |     | I. substitution (QWERTY slip)    |   100.0% |
| C. punctuation deleted         |    21.6% |     | J. phonetic respelling           |    58.8% |
| D. punctuation → space         |    21.6% |     | K. romanisation variant          |    34.9% |
| E. straight → curly apostrophe |     7.1% |     | L. partial recall (token subset) |    23.1% |
| F. transposition               |    80.4% |     | M. partial recall, wrong order   |    55.6% |
| G. deletion (1 char)           |   100.0% |     |                                  |          |

---

## Item 6: what the cheap engine-agnostic columns actually buy

Every mechanism here is one or two ordinary indexed `TEXT` columns. All of them work on **D1**, block no export, and need no engine.

### Recall by error class

38,001 names indexed, 300 query pairs per class (60 for the two brute-force mechanisms), `spike/typo-search/evaluate.mjs`. Mechanism 9 is what D1's FTS5 does **today**; 11 is what Typesense, Meilisearch and Algolia do.

| Error class                    | 1 exact | 2 folded | 3 fold+sorted | 4 metaphone | 5 fold→meta | 7 trigram ≥0.3 | 8 DamLev ≤2 | 9 token AND | 10 token AND+meta | 11 token AND+fuzzy |
| ------------------------------ | ------: | -------: | ------------: | ----------: | ----------: | -------------: | ----------: | ----------: | ----------------: | -----------------: |
| A. dropped diacritic           |      0% | **100%** |          100% |        100% |        100% |           100% |        100% |        100% |              100% |               100% |
| B. untypeable symbol           |      0% |      17% |           17% |         17% |         17% |           100% |         98% |     **97%** |               97% |                97% |
| C. punctuation deleted         |      0% |      74% |           74% |         74% |         74% |           100% |         98% |         74% |               76% |                78% |
| D. punctuation → space         |      0% |      67% |           67% |         67% |         67% |           100% |        100% |         67% |               67% |                67% |
| E. straight → curly `’`        |      0% | **100%** |          100% |        100% |        100% |           100% |        100% |        100% |              100% |               100% |
| F. transposition               |      0% |       0% |            0% |         46% |         46% |            95% |        100% |          0% |               44% |            **92%** |
| G. deletion                    |      0% |       0% |            0% |         33% |         33% |            98% |        100% |          0% |               31% |            **85%** |
| H. insertion                   |      0% |       0% |            0% |         90% |         90% |           100% |        100% |          0% |               87% |           **100%** |
| I. QWERTY slip                 |      0% |       0% |            0% |         22% |         22% |            98% |        100% |          0% |               21% |            **90%** |
| J. phonetic respelling         |      0% |       0% |            0% |     **90%** |         90% |           100% |         97% |          0% |               85% |                90% |
| K. romanisation variant        |      0% |       0% |            0% |     **85%** |         85% |           100% |        100% |          0% |               78% |                88% |
| L. partial recall (subset)     |      0% |       1% |            1% |          1% |          1% |            73% |      **2%** |     **83%** |               83% |                75% |
| M. partial recall, wrong order |      0% |       0% |          100% |          0% |          0% |           100% |      **0%** |    **100%** |              100% |               100% |
| _unweighted mean_              |    _0%_ |    _24%_ |         _33%_ |       _56%_ |       _56%_ |          _97%_ |       _84%_ |       _42%_ |             _72%_ |              _89%_ |
| _mean candidates returned_     |   _0.0_ |    _0.3_ |         _0.4_ |       _0.7_ |       _0.7_ |          _6.2_ |       _1.2_ |       _0.7_ |             _1.3_ |              _1.4_ |

### The folded column: two keys, not one, and it is worth 100%

The single folded key trades classes C and D against each other, because one rule cannot serve both a customer who _omits_ an apostrophe (`Farfetchd`) and one who _replaces_ a hyphen with a space (`Ho Oh`). Measured at 1,500 pairs per class (`spike/typo-search/punctuation-probe.mjs`):

| Rule                                      | C. punctuation deleted | D. punctuation → space | E. curly `’` | A. accents |
| ----------------------------------------- | ---------------------: | ---------------------: | -----------: | ---------: |
| Fold, apostrophe → space (the naive rule) |                    46% |               **100%** |         100% |       100% |
| Fold, apostrophe deleted                  |                    77% |                    68% |         100% |       100% |
| **Fold + a second space-stripped key**    |               **100%** |               **100%** |     **100%** |   **100%** |

The second key is `fold(name)` with spaces removed, looked up only when the first misses. **Collision cost: 76 names of 38,001 share a key, 0.20%, largest bucket 2** — and the collisions are benign (`Clear the Mind` / `Clear, the Mind`; `Keep Out` / `KEEP OUT`).

The fold rule that produced this: NFKD → strip combining marks → lowercase → **delete apostrophes** (`'`, `’`, `ʼ`, `‘`, `` ` ``) → everything else non-alphanumeric to a space → collapse. NFKD rather than NFD is deliberate: it also decomposes compatibility forms, and symbols that decompose to nothing (`δ`, `◇`, `★`, `♀`) fall out entirely, which is correct because nobody can type them.

**Two indexed columns, no engine, 100% of the accent, punctuation and smart-quote classes.** That is the cheapest result on this ticket and it is available on D1 today.

### Double Metaphone: right tool, wrong billing

The map describes a phonetic key as catching _"phonetic misspellings on any engine including D1"_. That is exactly right and it is worth restating what it does **not** do, because #24's phrasing could be read as typo tolerance:

- **Phonetic respelling 90%, romanisation variant 85%.** Real value. `Kouzuki`/`Kozuki` is a genuine ambiguity — Bandai's official English romanisation and the one every player uses are different strings — and this is the mechanism that bridges it.
- **QWERTY slip 22%, deletion 33%, transposition 46%.** A phonetic key is not an edit-distance mechanism and scores like one that is not.

Collision cost is low enough to be free: **1,295 of 38,001 names (3.4%) share a Double Metaphone key, p99 bucket 2, largest bucket 11.** The worst buckets are exactly what you would expect and are tolerable as a _fallback_ candidate set: `KN` → `Conney / Gin / Gina / Ginny / Kuina / Kuween …`, `SR` → `Sear / Serra / Soar / Sorry / Zorua / Zeri …`.

**Computed per token on the folded form, and used as a fallback after the folded key misses.** One more indexed column, `double-metaphone@2.0.1`, MIT.

### The finding that reframes item 6 entirely

Look at the last two rows of the recall table. **Damerau-Levenshtein ≤ 2 — the ceiling of what any typo-tolerant engine does — scores 2% and 0% on partial recall. Plain token-AND matching, which D1's FTS5 already does, scores 83% and 100%.**

Partial recall is not a typo. `mind sculptor` for `Jace, the Mind Sculptor` is a five-edit distance and a trivial token match. Since 88.8% of real names are multi-token and 55.6% are exposed to wrong-order recall, **the largest single category of "search didn't find my card" is one that typo tolerance cannot touch and that D1 already handles.** No prior ticket separates these two failure modes; #16 folded them together as "typo tolerance" and that is why the requirement looked bigger than it is.

---

## Item 1: Postgres `pg_trgm` with GiST and `<->`

### The documentation, and the specific question

Issue #19 measured the Postgres planner **declining** a trigram index under `ORDER BY … LIMIT`, and #16 recorded the caveat that _"similarity-ordered queries need GiST and the `<->` operator; GIN serves `%` filtering but not ordering"_. The [pg_trgm documentation](https://www.postgresql.org/docs/17/pgtrgm.html) (fetched 2026-09-08) says exactly that, verbatim, of the k-nearest-neighbour form:

> ```
> SELECT t, t <-> 'word' AS dist FROM test_trgm ORDER BY dist LIMIT 10;
> ```
>
> "This can be implemented quite efficiently by GiST indexes, but not by GIN indexes."

and defines the operator as _"the 'distance' between the arguments, that is one minus the `similarity()` value"_, with `pg_trgm.similarity_threshold` defaulting to 0.3. The docs make **no claim** about which index type is faster or larger: _"The choice between GiST and GIN indexing depends on the relative performance characteristics of GiST and GIN, which are discussed elsewhere."_

### Measured: Postgres 17.11, 150,000 Printings, 38,001 distinct real names

`spike/pg-trgm-gist/`, local Docker, `EXPLAIN (ANALYZE, BUFFERS)`, `pg_trgm` 1.6.

Index sizes on the same column set:

| Index                               |                                 Size |
| ----------------------------------- | -----------------------------------: |
| `GIST (name gist_trgm_ops)`         |                                15 MB |
| `GIST (name_folded gist_trgm_ops)`  |                                15 MB |
| `GIN (name gin_trgm_ops)`           |                             6,992 kB |
| `GIN (name_folded gin_trgm_ops)`    |                             6,984 kB |
| `(game_system, name_folded)` B-tree |                             4,392 kB |
| Heap only                           | 14 MB · **total with indexes 67 MB** |

**GiST is 2.1× the size of GIN** for the same column. Undocumented, measured.

| Query                                                                    | Plan                                                                    |         Time |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -----------: |
| `WHERE name % $1 LIMIT 20`                                               | Bitmap Index Scan on **GiST**                                           |      30.3 ms |
| `WHERE name % $1 ORDER BY similarity() DESC LIMIT 20` _(#19's shape)_    | Bitmap Index Scan on GiST → top-N heapsort                              |  **16.3 ms** |
| `ORDER BY similarity() DESC LIMIT 20`, no `%` filter                     | **Parallel Seq Scan**, 150,000 rows                                     |     127.1 ms |
| **`ORDER BY name <-> $1 LIMIT 20`**                                      | **`Index Scan using cp_name_trgm_gist … Order By: (name <-> $1)`**      |  **21.5 ms** |
| `ORDER BY name_folded <-> $1 LIMIT 20`                                   | Index Scan using `cp_folded_trgm_gist`, Order By                        |      36.9 ms |
| Game-scoped: `WHERE game_system=$1 ORDER BY name_folded <-> $2 LIMIT 20` | Index Scan on GiST, Order By, `Filter: game_system`, **7 rows removed** |      20.8 ms |
| Game-scoped + `%` filter, `ORDER BY <->`                                 | Bitmap Heap Scan → quicksort                                            | 18.4–28.2 ms |
| `ORDER BY name_folded <<-> $1` (word_similarity)                         | **Parallel Seq Scan**                                                   | **120.3 ms** |
| `ORDER BY name_folded <<<-> $1` (strict_word_similarity)                 | **Parallel Seq Scan**                                                   | **113.5 ms** |
| `WHERE game_system=$1 AND name_folded = $2` (the folded hit)             | Index Scan on B-tree                                                    | **0.059 ms** |
| The same, **missing** (what triggers the fallback)                       | Index Scan, 0 rows                                                      | **0.013 ms** |

**Answer to the ticket's question: yes, GiST plus `<->` fixes it.** The planner emits `Order By: (name <-> $1)` on an index scan and stops after 20 rows. #19's finding was about `LIKE`-style substring search against a GIN index and **does not generalise** to similarity ordering with GiST. #16's caveat was correct and is now verified on a real corpus.

Four things the ticket did not ask that change the reading:

**The game scoping works, by luck rather than design.** `WHERE game_system = 'magic' ORDER BY name_folded <-> $1` uses the GiST order-by and applies the game as a post-filter, discarding only 7 rows. That is fine because the query is already ordered by _similarity_, so the nearest neighbours are overwhelmingly in the right game. It would degrade for a Game System that is a small fraction of the Catalogue and whose names resemble another's. `btree_gist` would allow a genuine composite; not tested.

**The word-similarity operators are a trap.** `<<->` and `<<<->` are the natural choice for typeahead — "is the query a word inside this name" — and **neither uses the index**. Both plan a parallel sequential scan over 150,000 rows at 113–120 ms. That is 5× the `<->` figure and 2,000× the folded-column hit. Not documented as a limitation anywhere in the pg_trgm page.

**Threshold sensitivity is severe.** For one query, `name_folded % 'lighming bolt'` matched **48 rows at the default 0.3, 4 rows at 0.5, and 1,037 rows at 0.15**. A 0.15 setting turns the candidate set into something a UI cannot show.

**It does find the right card.** Correctness on real misspellings of real names, top 3 by `<->` distance:

| Typed           | Top 3 returned                                                              |
| --------------- | --------------------------------------------------------------------------- |
| `lighming bolt` | **Lightning Bolt** \| Lightning Colt \| Guiding Bolt                        |
| `farfetchd`     | **Farfetch'd** \| Galarian Farfetch'd \| Galarian Sirfetch'd                |
| `kozuki oden`   | **Kouzuki Oden** \| Kozuki Sukiyaki \| Kouzuki Toki                         |
| `bell mere`     | **Bell-mère** \| Gum-Gum Bell \| Junkyo Bell                                |
| `kaisa`         | **Kai'Sa** \| Aisa \| Kaido                                                 |
| `flabebe`       | **Flabébé** \| Flay \| Flare                                                |
| `sheldred`      | Shell Shield \| Reaper of Sheoldred \| Sheltered Aerie — **miss at rank 1** |

Six of seven correct at rank 1. That is the best correctness measured anywhere in this document, and it is the honest reason to like `pg_trgm`.

### What could not be measured, and why it matters

**Worker-to-provider wall-clock for Neon, PlanetScale Postgres or a Hyperdrive-fronted database is not measured here and could not be.** Every path requires provisioning a hosted database and deploying a Worker, which this spike's ground rules forbid and which the available Wrangler token could not do anyway. #19 and #20 left the same gap and this spike leaves it open rather than papering over it.

**Cloudflare's 500 ms uncached / 320 ms cached Hyperdrive figures are cross-region and are not quoted here as a prediction.** #19 already recorded that caveat and it stands. Substituting them for a measurement would be exactly the error this document is trying not to make. **All figures above are server-side, warm, single-client, local** — as are the D1 figures they are compared against.

---

## Item 2: hand-rolled trigram overlap on D1

`spike/d1-trigram/`, local workerd/miniflare, 150,000 Printings, seven runs per query, median. `rows_read` is D1's own counter.

### The corpus correction, first

The same schema and the same query, on two corpora:

| Corpus                                                  | Distinct names | Distinct trigrams | Trigram rows | `rows_read` for one query |    Median |
| ------------------------------------------------------- | -------------: | ----------------: | -----------: | ------------------------: | --------: |
| **Generated** (`spike/d1-search/seed.ts`, #13's corpus) |          9,000 |           **405** |    3,526,573 |             **1,391,435** |    109 ms |
| **Real** (38,001 real card names)                       |         38,001 |         **7,053** |    2,515,715 |               **255,059** | **17 ms** |

The generated corpus's 405 distinct trigrams make every trigram catastrophically unselective — its most common trigrams are `"  o"` at 85,491 rows and `" of"` at 80,898. **Any trigram measurement taken on that corpus overstates the cost by roughly 5.5×.** #13 flagged the vocabulary as a limitation for FTS5 index _size_; it turns out to be decisive for trigram _read cost_, which #13 did not measure. Every figure below is the real-corpus figure.

### Shape A: one row per (trigram, printing_id) — #16's table

|                              | Measured                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Rows                         | **2,515,715** (16.8 per Printing; #16 guessed ~3M, close)                         |
| Size                         | table 77.5 MB + index 79.4 MB = **157.0 MB**                                      |
| Load                         | 2,369 ms; index built in 1,060 ms                                                 |
| Full re-seed                 | 2,515,715 `rows_written` = **16.8 billed rows per Printing**, trigram table alone |
| 2,000-Printing delta re-sync | **53.2 billed rows per Printing** (delete 35,478 + write 70,956), 485 ms          |

| Query                                                                          | Median | `rows_read` | Returned |
| ------------------------------------------------------------------------------ | -----: | ----------: | -------: |
| A1 `WHERE trigram IN (…) GROUP BY printing_id ORDER BY COUNT(*) DESC LIMIT 20` |  17 ms | **255,059** |       20 |
| A2 the same, joined back for a name                                            |  18 ms |     255,079 |       20 |
| A3 with `HAVING overlap >= 60%` of query trigrams                              |  19 ms |     184,882 |        4 |
| A4 game-scoped (top-200 then filter)                                           |  25 ms |     285,472 |       20 |

Plan: `SEARCH printing_trigram USING COVERING INDEX pt_trigram (trigram=?) | USE TEMP B-TREE FOR GROUP BY | USE TEMP B-TREE FOR ORDER BY`.

**Answer to #16's guess: it lands near the 113,000-row tail and then goes past it — 255,059 rows read, 2.3×.** But at 17 ms it is a fifth of that tail's 109 ms, because it is a covering-index walk rather than a table scan with heap probes. #16 was right in kind and wrong about the consequence.

### Shape B: one row per distinct name, then join — not considered by #16

The Catalogue holds many Printings per name (150,000 over 38,001 in this corpus, and a real Catalogue is worse — every set, variation, finish and language repeats the name). Indexing the _name_ once and joining to Printings gives the identical answer over less data.

|                                           |   Shape A |         **Shape B** |
| ----------------------------------------- | --------: | ------------------: |
| Rows                                      | 2,515,715 | **634,802** (25.2%) |
| Size                                      |  157.0 MB |   **42.6 MB** (27%) |
| `rows_read`, overlap + join to Printings  |   255,059 |          **64,501** |
| `rows_read`, overlap only (candidate ids) |   255,059 |          **64,492** |
| Median                                    |     17 ms |          **4–5 ms** |
| Full re-seed `rows_written`               | 2,515,715 |         **634,802** |

**Four times cheaper on reads, four times cheaper on storage, four times cheaper on writes, for the same result.** And the asymmetry grows: shape B's cost scales with the number of **distinct names**, shape A's with the number of **Printings**. The ticket asks where the answer changes at 500k Printings — this is where. At 500k Printings shape A grows 3.3× to roughly 8.4M rows and 520 MB, while shape B barely moves, because 500k Printings do not carry 3.3× as many distinct names. _(That scaling statement is reasoned from the measured structure, not separately measured — see [What remains unverified](#what-remains-unverified).)_

### The zero-result fallback, which is the variant that matters

| Query                                                         |   Median | `rows_read` |
| ------------------------------------------------------------- | -------: | ----------: |
| Folded-column **hit** (`game_system = ? AND name_folded = ?`) | **0 ms** |       **4** |
| Folded-column **miss** — what triggers the fallback           | **0 ms** |       **0** |

**Determining that the cheap path missed costs zero rows read and zero milliseconds.** So the trigram table is not a tax on every query; it is a tax on queries that would otherwise have returned nothing. Combined with item 6 — where two folded keys take classes A–E to 100% and token-AND takes B, L and M to 83–100% — the fallback only has to fire for genuine single-edit typos (classes F–I) and phonetic/romanisation misses (J, K), and a Double Metaphone column absorbs 85–90% of the latter before the trigram table is reached at all.

### Against D1's billing and limits

On Workers Paid ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)): 25 billion rows read and 50 million rows written included per month.

|                                                    | Shape A |      Shape B |
| -------------------------------------------------- | ------: | -----------: |
| Fallback queries/month within the read allowance   | ~98,000 | **~387,000** |
| Full 150k re-seed, as share of the write allowance |    5.0% |     **1.3%** |
| Added storage against D1's 10 GB ceiling           |    1.6% |     **0.4%** |

Adding shape B to the ~112 MB #13 measured for the full searchable mirror gives roughly **155 MB, about 1.6% of the ceiling**. **Money is not the constraint; it was not for #13 either.** The constraint remains the single-threaded database and the 30-second query cap, and at 4–5 ms neither is threatened.

---

## Item 3: Orama inside a Worker

`spike/orama-worker/`. `@orama/orama@3.1.18`, `@orama/plugin-data-persistence@3.1.18`, both Apache-2.0.

### It runs

Inside real workerd (`@cloudflare/vitest-pool-workers`), resolving Orama's `browser` export condition, no Node built-ins, no polyfills:

|   Documents | Schema                                          |      Build | Search (`tolerance: 2`) |
| ----------: | ----------------------------------------------- | ---------: | ----------------------: |
|      38,001 | name only                                       |     125 ms |                   10 ms |
|      38,001 | name + game + rarity + `sellPrice` + `quantity` |     268 ms |                    9 ms |
|      75,000 | + filters                                       |     512 ms |                    8 ms |
|     100,000 | + filters                                       |     758 ms |                    4 ms |
| **150,000** | + filters                                       | **989 ms** |                **6 ms** |

Orama's npm `exports` map has `deno`, `browser`, `import` and `require` conditions and **no `worker` condition**; Workers resolves `browser`. Cloudflare Workers is not named in Orama's README or docs, which claim only _"in your browser, server or edge network"_.

### It does not fit

Measured in Node, one size per process, heap after an explicit GC:

|   Documents | Schema        | Settled heap | Serialised (`persist('json')`) |
| ----------: | ------------- | -----------: | -----------------------------: |
|      38,001 | name only     |        47 MB |                         9.0 MB |
|      38,001 | + filters     |        72 MB |                        15.7 MB |
|      50,000 | + filters     |    **83 MB** |                        20.0 MB |
|      75,000 | + filters     |       111 MB |                        28.1 MB |
|     100,000 | + filters     |       128 MB |                        36.1 MB |
| **150,000** | **+ filters** |   **184 MB** |                    **53.2 MB** |
|     150,000 | name only     |       113 MB |                        29.7 MB |

Against [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (fetched 2026-09-08), verbatim:

> "Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations."

and, decisively, the docs state this limit applies **per isolate, not per invocation** — the same isolate serves many concurrent requests **and the rest of the Nuxt application**. 184 MB of index in a 128 MB isolate that also has to hold the app is not a near miss.

Three further hard blocks:

**Restore is worse than build.** Loading the serialised index measured **454 ms and a 320 MB peak heap**, settling to 196 MB after GC. Whatever the steady state, the transient exceeds the ceiling by 2.5×.

**The index does not fit in KV.** [KV limits](https://developers.cloudflare.com/kv/platform/limits/) (fetched 2026-09-08) cap a value at **25 MiB**; the index is 53.2 MB. R2 is the only option, and #25 raised this as an open question — the answer is that KV is closed off above roughly 70k documents.

**Only one serialisation format works.** `persist(db, 'binary')` failed at 150k with `Too deep objects in depth 101`; `persist(db, 'dpack')` failed with `"length" is outside of buffer bounds`. Only `'json'` succeeded, and it also threw `RangeError: Maximum call stack size exceeded` when several indexes were built in one process — it succeeded at every size when each ran in a fresh process, so the failure is heap-state-dependent rather than size-dependent. `persistToFile`/`restoreFromFile` use filesystem APIs and are unusable in a Worker regardless.

**Where it does fit: roughly 50,000 documents with filters, at 83 MB.** That is a third of the corpus, and there is no natural way to cut a Catalogue to a third.

### Its typo tolerance is the weakest measured

Recall at 1/3/10 on the same error classes, 200 pairs per class, 38,001 distinct names:

| Error class                    | `tolerance: 1` @1 / @3 | `tolerance: 2` @1 / @3 |         ms |
| ------------------------------ | ---------------------- | ---------------------- | ---------: |
| A. dropped diacritic           | 43% / 44%              | 45% / 59%              |  2.5 / 8.4 |
| E. straight → curly `’`        | **16% / 21%**          | 12% / 17%              | 7.1 / 13.4 |
| **F. transposition**           | **0% / 0%**            | 68% / 76%              |  0.9 / 4.2 |
| G. deletion                    | 81% / 84%              | 62% / 77%              |  1.2 / 5.3 |
| H. insertion                   | 83% / 85%              | 78% / 87%              |  1.2 / 5.2 |
| I. QWERTY slip                 | 79% / 81%              | 72% / 81%              |  1.1 / 5.2 |
| J. phonetic respelling         | 62% / 65%              | 70% / 81%              |  0.8 / 4.6 |
| L. partial recall (subset)     | 41% / 61%              | 20% / 35%              |  2.6 / 7.8 |
| M. partial recall, wrong order | 89% / 98%              | 62% / 73%              |  1.9 / 7.5 |

Three things here are decision-relevant even though Orama is out on memory:

**`tolerance: 1` scores 0% on transpositions.** Orama's docs describe _"the Levenshtein algorithm … insertions, deletions or substitutions"_ — plain Levenshtein, where a transposition costs 2. This is the measured consequence of a documented design choice, and it is exactly where Typesense's Damerau-Levenshtein differs.

**Accents are only 43–45% at rank 1 and smart quotes are 12–19%.** Orama does not reliably normalise either. **A folded column is needed even with a typo-tolerant engine** — item 6 is not an alternative to an engine, it is a prerequisite for one.

**No single setting is good.** `tolerance: 1` misses every transposition; `tolerance: 2` halves partial-recall precision and costs 4–13 ms against 1 ms. `threshold: 0` (require all tokens) is mandatory — the default OR-of-tokens returned 105 hits for `Lightning Bolt` with `Boltbender` ranked first.

---

## Item 4: Typesense, Meilisearch, Algolia

**Documentation and pricing only. Nothing here was measured**, and nothing was provisioned. All URLs fetched 2026-09-08.

### Typo tolerance, as documented

|                      | Typesense                                                                    | Meilisearch                                                                                 | Algolia                                                                           |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Algorithm            | **Damerau-Levenshtein** (transpositions cost 1)                              | "a prefix **Levenshtein** algorithm" (transpositions cost 2)                                | Damerau-equivalent — "additions, deletions, substitutions, or **transpositions**" |
| 1-typo threshold     | `min_len_1typo` = **4**                                                      | `oneTypo` = **5**                                                                           | `minWordSizefor1Typo` = **4**                                                     |
| 2-typo threshold     | `min_len_2typo` = 7                                                          | `twoTypos` = 9                                                                              | `minWordSizefor2Typos` = 8                                                        |
| Per-field disable    | yes (`num_typos=0,1,1`)                                                      | yes (`disableOnAttributes`)                                                                 | yes (`disableTypoToleranceOnAttributes`)                                          |
| **Per-word disable** | **not found**                                                                | yes (`disableOnWords`)                                                                      | yes (`disableTypoToleranceOnWords`)                                               |
| Accent folding       | **on by default** for `en` fields — "diacritics … are automatically removed" | yes, via charabia: "compatibility decomposition + lowercase + **nonspacing-marks removal**" | **not documented anywhere I could find**                                          |

**The buried Typesense limit that matters most for this corpus**, verbatim:

> "`max_candidates` … **Default: `4`** … But for performance reasons, Typesense will only consider the top `4` prefixes and typo variations by default."

Against 38,001 invented proper nouns that is the single thing most likely to make typo tolerance feel broken. `exhaustive_search: true` raises it to 10,000 and disables `drop_tokens_threshold`/`typo_tokens_threshold`, at an unmeasured latency cost.

**Algolia's defaults are not what the marketing implies.** `removeWordsIfNoResults` defaults to `none` — _"If no results are found, an empty result set is returned"_ — and `ignorePlurals` defaults to `false`. Out of the box a two-word query where one word misses returns nothing.

### The truncation problem: which of them dissolves it

This is the question #16 raised and #24 must answer, and it separates the three cleanly.

**Typesense — dissolves it.** Numeric fields are sortable by default (_"`sort` property: Default: `true` for numbers"_), and `sort_by` accepts up to three fields **per query** blended with relevance:

> "The text similarity score is exposed as a special `_text_match` field that you can use in the list of sorting fields. If one or two sorting fields are specified, `_text_match` is used for tie breaking."

So `filter_by: quantity:>0 && game:=magic`, `sort_by: sellPrice:asc,_text_match:desc`, one index, one query, exact pagination (250 hits per page, `limit_hits` default no limit). Partial updates are one `PATCH` per Printing or a bulk `action=update` import.

**Meilisearch — dissolves it, less flexibly.** `sortableAttributes` covers integer quantity and price, but sort is a **ranking-rule position set on the index**, not a per-query choice: _"'sort' is in fifth place … it acts as a tie-breaker rule."_ And `maxTotalHits` defaults to **1,000** with the docs' own warning that values _"over 20000 may result in queries taking seconds to complete."_ Writes are **asynchronous** — _"Meilisearch places them in a queue"_ — so the index is eventually consistent with the Transaction, and #6 requires stock be exact rather than advisory.

**Algolia — structurally wrong, by its own words.** Verbatim:

> "**Algolia enforces one ranking formula per index and doesn't allow changing sort strategies at query time.**"

Each exhaustive sort order needs a **standard replica**, which _"increases the number of records since it's a copy"_, confirmed on the pricing page: _"each pre-sort of your records … increases your total record count."_ And `paginationLimitedTo` caps at **10,000** results, so exact deep pagination over 150k Printings is unavailable at any price.

### Cost at 150,000 Printings, from official pricing pages only

| Vendor                | Plan                                       | Arithmetic                                               |                                      Monthly |
| --------------------- | ------------------------------------------ | -------------------------------------------------------- | -------------------------------------------: |
| **Typesense Cloud**   | 1 GB, 2 vCPU w/ burst, n_california, no HA | vendor's own configurator: $0.04/hr                      |                                   **$28.80** |
|                       | 2 GB, 4 hr burst                           | $0.07/hr                                                 |                                       $50.40 |
|                       | 3-node HA, 2 GB                            | $0.21/hr                                                 |                                      $151.20 |
| **Meilisearch Cloud** | Build (usage-based)                        | 50k docs over the 100K allowance × $0.30/1k = $15 + base | **~$35–45** (base fee not published in docs) |
| **Algolia**           | Grow, baseline                             | (150k−100k)/1k × $0.40 = $20 + ~$10 searches             |                                     **~$30** |
|                       | Grow, **+4 sort replicas**                 | +600,000 records × $0.40/1k = **+$240**                  |                                    **~$270** |

Typesense's own sizing guidance is _"2X-3X MB RAM"_ for an X MB dataset, which puts 150k Printings at 90–450 MB and makes the 1–2 GB tier the right pick. **Note the burst-CPU tiers**: the cheap Typesense SKUs give "2 vCPUs, N hr burst per day", and their docs say 2 vCPUs is the _minimum to operate_.

Licences: **Typesense GPL-3.0**; **Meilisearch dual — MIT community edition, Business Source License 1.1 / commercial for enterprise** (sharding and replication are Enterprise); Algolia proprietary.

### Self-hosting on Cloudflare: closed off

Cloudflare Containers is GA (changelog 2026-04-13, _"Cloudflare Containers and Sandboxes are now generally available"_), and an always-on `basic` instance would cost roughly $8–15/month by their published rates — cheaper than any managed option. It does not work, for a reason stated plainly in Cloudflare's own FAQ:

> "**All disk is ephemeral. When a Container instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its container image.**"

plus _"a host server restart, which happens on an irregular cadence"_ and 1–3 second cold starts. Every sleep wipes the index and forces a full 150k re-ingest. The static Catalogue could be baked into the image; the mutable stock and Sell Price — precisely the fields the second write path exists to maintain — could not. **Self-hosting means leaving Cloudflare.**

### Reaching them from a Worker

All three are plain REST over `fetch`. **None publishes a Cloudflare Workers guide.**

- **Meilisearch's client is the best fit**: `meilisearch` npm declares **zero dependencies** and is fetch-based. Its README says other runtimes _"aren't tested"_ and does not name Workers.
- **Algolia's client is fine despite the docs**: `algoliasearch@5.x` `package.json` declares an explicit **`"worker"` export condition** resolving to `./dist/worker.js` and depends on `@algolia/requester-fetch`. The docs never mention it; the source is decisive.
- **`typesense-js` is a hazard**: it depends on `axios` and stubs `http`/`https`/`crypto` to `false` in its `browser` field. Whether axios's adapter resolution works in a Worker is undocumented by Typesense. _This is reasoning from the package manifest, not a measured incompatibility._ The safe answer is to call Typesense's REST API with `fetch` directly and skip the client.

---

## Item 5: search at the Catalogue

Read-only reconnaissance of `KeeprDigital/card-keepr` at commit `0bb3b7d`. No issues, comments or PRs were opened there; #23 owns that channel.

### card-keepr already has search, and both #24 and #25 are wrong that it does not

`GET /v1/cards?q=` is live, authenticated and revision-pinned. The contract at `prototype/formalize-implementation-contracts/openapi.json` describes it verbatim:

> "`q` is an exact case-insensitive Unicode substring search over official identity value, name, and Effective Rules Text without crossing field boundaries."

It is backed by **SQLite FTS5 with the trigram tokenizer in D1** — `migrations/0001_baseline.sql:2432`:

```sql
CREATE VIRTUAL TABLE revision_card_search_fts USING fts5(
  revision_token, catalogue_revision_id UNINDEXED, card_id UNINDEXED,
  field_ordinal UNINDEXED, chunk_ordinal UNINDEXED, search_text,
  tokenize = 'trigram case_sensitive 1'
);
```

`/v1/products` also takes `q` (tokenizer `unicode61 remove_diacritics 2`). The contract's eleven paths match the eleven registered routes in `src/catalogue/read/routes.ts` exactly, as #5 recorded.

### But it is the wrong search, on four counts

**No ranking, at all.** There is no `bm25()`, no `rank`, no scoring column anywhere in the repo. Every ordering is the deterministic tuple `ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id` — results come back in card-number order, not relevance order.

**No typo tolerance.** The trigram tokenizer buys substring matching, and the query path then re-verifies with an exact `instr()` (`src/catalogue/read/card-collection-repository.ts:99-104`): `"instr(search.search_text, ?) > 0"`. No edit distance, no `spellfix1`, no phonetic key, no synonyms. This is the same conclusion #16 reached about D1 generally.

**Diacritics are not folded on the Card path.** `normalizeCardSearchText` is `NFKC → toLocaleLowerCase("und") → NFKC` — NFKC _preserves_ accents. So `Ace` does not match `Ácé` on `/v1/cards`, while `/v1/products` does fold via `remove_diacritics 2`. Given item 7's finding that accents are only 0.3% of names this is a small hole, but it is a real inconsistency between two endpoints of the same API.

**`/v1/printings` has no text index whatsoever.** Its projection (`migrations/0006_printing_query_projection.sql`) is `(catalogue_revision_id, printing_id, card_id, supported_game, normalized_rarity)` — no name, no searchable string. A **ranked Printing-id endpoint is genuinely new work**, not a parameter on an existing route.

There is also a shape problem for a store: `q` always searches Effective Rules Text as well as the name, and cannot be restricted to the name. Searching `dragon` hits every card whose rules text mentions dragons.

### It was already decided, and the decision was "no"

`card-keepr#51`, _"Decide the Releases and search API surface before freezing /v1"_ — **closed 2026-08-06**. Its body states the position directly:

> "**No dedicated `/v1/search`.** Search is the `q` parameter on `/v1/cards` (FTS5-backed, revision-pinned). Printings/products have filter parameters but no free-text search."

`card-keepr#35`, closed the same day, carries the architectural commitment in its acceptance criteria: _"D1 FTS5 and relational indexes produce the contract ordering without requiring an external search service."_

**Zero open issues mention search**, and zero hits across the tracker for `typo`, `trigram`, `autocomplete`, `typeahead` or `relevance`.

### What it would cost, and why the window is narrower than it looks

**Eleven open issues remain in the whole repo**, of which ~9 are substantive Go-Live prerequisites: #216 (multi-publisher catalogue and staged release, named in #136 as _"a native blocker of this freeze"_) plus its sub-issues #233, #236–#240, #151, #253. None is discretionary feature work.

The load-bearing obstacle is not effort, it is the **cursor contract**. The opaque cursor pins the order string literally (`"game,official_identity.kind,official_identity.value,id"`) and `parseCursor` rejects any cursor whose order differs. **Relevance ordering is not a stable keyset**, so a ranked endpoint cannot use the existing cursor design at all: it needs either a new versioned cursor contract or to be non-paginated top-N.

And #136 states as a prerequisite: _"refresh existing draft proofs after every prerequisite schema change."_ Any new table or index invalidates the draft Go-Live proofs and re-runs the evidence ladder.

**So the ask splits into a cheap version and an expensive one:**

- **Cheap:** a rank-only, non-paginated top-N variant reusing the _existing_ `revision_card_search_fts` index and the already-indexed `revision_printing_query_by_card` join, adding **no schema**. A scoring function, a route variant, a contract addition. It sidesteps the proof refresh almost entirely. Note the `field_ordinal` column already exists and would carry field weighting.
- **Expensive:** a true Printing-level ranked search with its own `revision_printing_search` projection. Migration + new cursor contract + proof refresh, squarely on the Go-Live critical path.

Even the cheap version inherits card-keepr's trigram tokenizer, which gives substring matching and **not typo tolerance**. Getting typo tolerance at the Catalogue means building it there — the same build, in a repo with a freeze deadline and other consumers.

### The service binding is confirmed and is the best fact in this section

[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) (fetched 2026-09-08), verbatim:

> "When you use Service Bindings, there is **zero overhead or added latency**. By default, both Workers run on the same thread of the same Cloudflare server."
> "Each request to a Worker via a Service binding **counts toward your subrequest limit**."
> "This Worker must be on your Cloudflare account."

A single request has a maximum of **32 Worker invocations**. Local development is supported: `wrangler dev -c ./shop-keepr/wrangler.jsonc -c ./card-keepr/apps/api/wrangler.jsonc`, or two `wrangler dev` processes — but either way it needs a **local card-keepr checkout with a populated local D1**, which given 28 migrations and a dependence on a published Catalogue Revision is a real cost, not a footnote.

Two corrections to #5's build facts while here:

- **The `localhost:3000` CORS restriction is irrelevant to a Worker caller.** `src/http/cors.ts:hasAllowedOrigin` returns `true` when the `Origin` header is absent, and server-to-server calls send none. CORS is a browser-only gate on that API.
- **There is no per-consumer key concept.** Authentication is a single shared dual-slot bearer key (`API_BEARER_KEY` / `API_BEARER_KEY_REPLACEMENT`, ADR 0005) with no scopes and no client identity. "Issuing shop-keepr a key" means sharing the one key every Catalogue Consumer uses, or building per-consumer auth that does not exist. A service binding sidesteps this entirely, which is a second argument for it.

### The ~150k figure is worse than unsourced

card-keepr's own research doc says so explicitly (`docs/research/2026-09-06-bounded-publication-platform.md:69`):

> "no full-game census or throughput benchmark … **Configured adapter request capacities are not observed entity counts. The synthetic ladder is neither a game inventory nor a launch-capacity claim.**"

The only real measured figure in that repo is fixture-scale: **8 accepted Printings** in one validated two-source journey (`docs/validation/issue-231-one-piece.md`). The 100,000 figure that appears in the repo is labelled _"Proposed larger synthetic scale test"_. And `#240 Enabled-game launch rehearsal` is still **open**, alongside `#239 Fresh-baseline handoff` which recreates the database from baseline — so the production Catalogue may hold only rehearsal data today. The public API returns 401 on every route including `/health`, and **no census, count or stats endpoint exists in the contract to call even with a key**.

---

## What remains unverified

**No hosted anything was provisioned, in line with this spike's ground rules.** Everything below is left open deliberately rather than papered over.

1. **Worker-to-provider wall-clock — the number #19, #20 and now #25 have all lacked.** Neon, PlanetScale Postgres and Hyperdrive all require provisioning a hosted database and deploying a Worker. Not done, not estimated, and Cloudflare's cross-region Hyperdrive figures are deliberately **not** substituted for it. **This is now the third consecutive spike to leave this gap, and #24 should decide whether it is willing to settle without it** — item 6 and item 2 together may make it moot, since they keep the answer on D1.
2. **Every D1 figure here is local workerd/miniflare.** Same obligation as #13, #4 and [#17](https://github.com/KeeprDigital/shop-keepr/issues/17). What should transfer unchanged: query plans, `rows_read` counts, index sizes, row counts. What must be re-measured: wall-clock, and whether `rows_read` is counted identically remotely.
3. **Every Postgres figure is server-side, warm, single-client, local Docker.** No network, no pooler, no Hyperdrive.
4. **No hosted search engine was measured.** Typesense, Meilisearch and Algolia are documentation and published pricing only. Typo-tolerance _quality_ in particular is quoted from their docs and not tested against the 38,001-name corpus, and the vendor docs are exactly where marketing lives.
5. **Write-to-searchable latency for the hosted engines** — the second-write-path cost on every Transaction. All three document writes as asynchronous or queued; **none publishes a latency figure**. This is the key unmeasured number for the truncation decision.
6. **Meilisearch's resource-tier hourly rates, and whether its usage-based "documents" quota means documents _stored_ or documents _indexed per month_.** Both are behind signup. The second materially changes both the cost estimate and the second-write-path cost. Meilisearch's own pricing page also contradicts itself on sizing: its formula puts 150k small documents inside the S tier, its tier table caps S at "~80K small documents".
7. **Whether Algolia virtual replicas are available on the Grow plan**, and **how Algolia folds accents** — no primary doc found for either.
8. **Whether shop-keepr and card-keepr share a Cloudflare _account_**, which is what the service-binding requirement actually turns on. The same GitHub org is established; the account boundary is not.
9. **The 500k scaling statement for the D1 trigram table is reasoned, not measured.** It follows from shape B's cost being a function of distinct names rather than Printings, which _is_ measured, but the 500k corpus itself was not built.
10. **The Riftbound corpus is a proxy** (Riot champion names, not Riftbound cards) and the **Pokémon corpus is a rate-limited sample** (1,599 of a much larger set). One Piece and Magic are complete. Hazard percentages for Riftbound and Pokémon should be read as indicative.
11. **The error-class weights are an assumption, not data.** There is no query log. Per-class recall is measured; any single "coverage" number would not be.
12. **Orama's memory verdict rests on Node heap measurements**, because `@cloudflare/vitest-pool-workers` does not enforce the production 128 MB isolate limit. The code-compatibility result _is_ from real workerd; the memory result is Node's `heapUsed` compared against Cloudflare's documented ceiling.

---

## What to carry into the build

1. **Two folded name columns, on whatever engine ships.** `name_folded` (NFKD, strip marks, lowercase, **delete apostrophes**, other punctuation to space, collapse) and `name_folded_nospace` (the same with spaces removed). Indexed, game-scoped composites. **100% of the accent, punctuation and smart-quote classes, 0.20% collision cost.** This is not an optimisation to defer; it is the cheapest correctness fix on the ticket and it is needed even if a hosted engine ships, because Orama scored 43% on accents and 16% on smart quotes and Algolia's folding is undocumented.
2. **A Double Metaphone column, as a phonetic fallback and nothing more.** 85–90% on romanisation and phonetic classes, 3.4% collision rate. Do not describe it as typo tolerance: 22% on a keyboard slip.
3. **Separate "partial recall" from "typo" in the requirement.** They are different failure modes with different fixes, and #16 conflated them. Token-AND matching — which D1's FTS5 already does — scores 83% and 100% on the two partial-recall classes where edit distance scores 2% and 0%. Given 88.8% of names are multi-token, this is probably the larger share of real misses.
4. **If D1 stays: build the trigram table per distinct name, not per Printing.** 64,492 rows read and 4–5 ms against 255,059 and 17 ms, at 27% of the storage and 25% of the write amplification, for an identical answer. Run it only as a zero-result fallback — determining the cheap path missed costs **0 rows read**.
5. **Never measure trigram behaviour on a generated corpus.** #13's 534-term corpus overstates trigram read cost by 5.5×. `spike/typo-search/data/all-card-names.json` holds 38,001 real names; use it.
6. **If Postgres ships: GiST plus `<->`, never `similarity()` ordering without a `%` filter, and never `<<->` or `<<<->`.** The word-similarity operators do not use the index and plan a 113–120 ms parallel seq scan. GiST is 2.1× GIN's size, which is the price of the ordering.
7. **Orama is out at this corpus size.** Record why, so it is not revisited: 184 MB against a 128 MB per-isolate ceiling, 320 MB restore peak, 53.2 MB index against KV's 25 MiB value limit, and only one of three serialisation formats works. It fits at ~50k documents.
8. **Algolia is out on its own documentation** — one ranking formula per index, no query-time sort switching, standard replicas billed as full record copies (~$270/month for four sort orders against ~$30 baseline), and a hard 10,000-result pagination ceiling.
9. **If a hosted engine ships, Typesense is the one to price.** It is the only one where stock quantity and Sell Price are filterable _and_ sortable _and_ blended with `_text_match` in a single per-query `sort_by` on a single index — which dissolves #16's truncation problem outright — at ~$29–50/month. Set `max_candidates` explicitly; the default of 4 will make typo tolerance feel broken on a corpus of invented proper nouns.
10. **Raise the typo-tolerance length thresholds from their defaults, whatever ships.** 17.3% of tokens are ≤ 3 characters and 11.7% are exactly 4. On Meilisearch's default, one in five Riftbound proper nouns (`Ahri`, `Ekko`, `Jinx`) gets no typo tolerance at all.
11. **The Catalogue is a cheap ask only if it needs no schema change.** A rank-only top-N variant on the existing `revision_card_search_fts` index avoids #136's proof-refresh obligation; a Printing-level search projection does not. And either way it inherits a trigram tokenizer with **no typo tolerance**, so it does not answer the requirement on its own. Use a **service binding** if it happens — zero documented overhead, and it sidesteps the fact that card-keepr has no per-consumer key concept.
12. **Correct the record on accents.** #16, #24 and #25 all lead with accents as the motivating hazard. They are 0.3% of names. The motivating hazards are punctuation (21.6%), multi-token partial recall (88.8% exposed), and untypeable symbols (a class none of them names).

---

## Sources

**Primary card-name data (all fetched 2026-09-08):**

- [Scryfall `/catalog/card-names`](https://api.scryfall.com/catalog/card-names) — 35,077 Magic card names
- [`api.pokemontcg.io/v2/cards`](https://api.pokemontcg.io/v2/cards) — Pokémon card names, rate-limited sample
- [`en.onepiece-cardgame.com/cardlist/`](https://en.onepiece-cardgame.com/cardlist/) — Bandai's official English One Piece card list, all 60 series
- [Riot Data Dragon `champion.json` 16.17.1](https://ddragon.leagueoflegends.com/cdn/16.17.1/data/en_US/champion.json) — League of Legends champion names, used as a **proxy** for Riftbound proper nouns

**Cloudflare (primary, all fetched 2026-09-08):**

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — the 128 MB per-isolate ceiling, 1 s startup CPU, 64 MiB script size, subrequest limits
- [KV limits](https://developers.cloudflare.com/kv/platform/limits/) — 25 MiB value cap
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) — "zero overhead or added latency", same thread, same account, subrequest counting
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Containers limits](https://developers.cloudflare.com/containers/platform/limits/) · [Containers pricing](https://developers.cloudflare.com/containers/pricing/) · [Containers FAQ](https://developers.cloudflare.com/containers/faq/) — "All disk is ephemeral" · [Containers GA changelog, 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)

**PostgreSQL (primary, fetched 2026-09-08):**

- [`pg_trgm`](https://www.postgresql.org/docs/17/pgtrgm.html) — `<->`, `<<->`, `<<<->`, `similarity()`, `word_similarity()`, `strict_word_similarity()`, the 0.3 default threshold, and "This can be implemented quite efficiently by GiST indexes, but not by GIN indexes"

**Search vendors (primary docs and official pricing, all fetched 2026-09-08):**

- Typesense: [search parameters](https://typesense.org/docs/30.2/api/search.html) (`num_typos`, `min_len_1typo`, `max_candidates`, `sort_by`/`_text_match`) · [collections](https://typesense.org/docs/30.2/api/collections.html) · [documents](https://typesense.org/docs/30.2/api/documents.html) · [locale guide](https://typesense.org/docs/guide/locale.md) · [system requirements](https://typesense.org/docs/guide/system-requirements.html) · [Cloud pricing configurator](https://cloud.typesense.org/pricing) · [repo, GPL-3.0](https://github.com/typesense/typesense)
- Meilisearch: [typo-tolerance settings](https://www.meilisearch.com/docs/learn/relevancy/typo_tolerance_settings) · [sorting](https://www.meilisearch.com/docs/learn/relevancy/sorting) · [pagination](https://www.meilisearch.com/docs/reference/api/settings/get-pagination.md) · [add and update documents](https://www.meilisearch.com/docs/capabilities/indexing/how_to/add_and_update_documents.md) · [async operations](https://www.meilisearch.com/docs/capabilities/indexing/tasks_and_batches/async_operations.md) · [pricing model](https://www.meilisearch.com/docs/capabilities/platform/billing/pricing_model.md) · [regions](https://www.meilisearch.com/docs/capabilities/platform/infrastructure/regions.md) · [charabia tokenizer](https://github.com/meilisearch/charabia) · [repo, MIT/BSL](https://github.com/meilisearch/meilisearch)
- Algolia: [`typoTolerance`](https://www.algolia.com/doc/api-reference/api-parameters/typoTolerance/) · [typo-tolerance guide](https://www.algolia.com/doc/guides/managing-results/optimize-search-results/typo-tolerance/) · [`customRanking`](https://www.algolia.com/doc/api-reference/api-parameters/customRanking/) · [replicas](https://www.algolia.com/doc/guides/managing-results/refine-results/sorting/in-depth/replicas/) · [`paginationLimitedTo`](https://www.algolia.com/doc/api-reference/api-parameters/paginationLimitedTo/) · [`partialUpdateObjects`](https://www.algolia.com/doc/api-reference/api-methods/partial-update-objects/) · [pricing](https://www.algolia.com/pricing)
- Orama: [`@orama/orama` repo, Apache-2.0](https://github.com/oramasearch/orama) · [search docs, `tolerance`](https://docs.orama.com/docs/orama-js/search) · [sorting](https://docs.orama.com/docs/orama-js/search/sorting) · [`plugin-data-persistence`](https://docs.orama.com/docs/orama-js/plugins/plugin-data-persistence) · open issues #480, #38, **#544 "Tolerance disables prefix search"**

**card-keepr (read-only, at commit `0bb3b7d`, 2026-09-08):** `prototype/formalize-implementation-contracts/openapi.json` · `src/catalogue/read/routes.ts`, `card-search.ts`, `card-collection-repository.ts`, `printing-collection-repository.ts`, `collection-endpoint.ts` · `src/catalogue/shared/card-search-contract.ts` · `src/http/cors.ts` · `migrations/0001_baseline.sql`, `0006_printing_query_projection.sql`, `0021_…`, `0022_atomic_game_publication.sql` · `apps/api/wrangler.jsonc` · `docs/research/2026-09-06-bounded-publication-platform.md` · `docs/validation/issue-231-one-piece.md` · issues [#51](https://github.com/KeeprDigital/card-keepr/issues/51), [#35](https://github.com/KeeprDigital/card-keepr/issues/35), [#136](https://github.com/KeeprDigital/card-keepr/issues/136), [#216](https://github.com/KeeprDigital/card-keepr/issues/216), [#240](https://github.com/KeeprDigital/card-keepr/issues/240)

**Measurements:**

- [`spike/typo-search/`](../../spike/typo-search/) — corpus collection, hazard frequency, the misspelling model, mechanism recall, the punctuation fold probe
- [`spike/d1-trigram/`](../../spike/d1-trigram/) — the hand-rolled trigram table on D1, both corpora, both shapes
- [`spike/pg-trgm-gist/`](../../spike/pg-trgm-gist/) — Postgres 17.11 `pg_trgm` GiST and GIN, `EXPLAIN (ANALYZE, BUFFERS)`
- [`spike/orama-worker/`](../../spike/orama-worker/) — Orama sizing in Node and execution inside workerd
