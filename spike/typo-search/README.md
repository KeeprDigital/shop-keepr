# Spike: what real card-name typos look like, and what the cheap columns catch

**Throwaway spike, not app code.** Items 6 and 7 of
[issue #25](https://github.com/KeeprDigital/shop-keepr/issues/25). Findings live in
[`docs/research/2026-09-08-typo-tolerant-search-options.md`](../../docs/research/2026-09-08-typo-tolerant-search-options.md).

It is the base the other three spikes on this ticket stand on: `data/all-card-names.json`
(38,001 real card names) is imported by `spike/d1-trigram/`, `spike/pg-trgm-gist/` and
`spike/orama-worker/`, because trigram and typo behaviour depend entirely on real name
vocabulary and the generated corpus in `spike/d1-search/` does not have one.

## The questions

6. How much typo tolerance does a normalised name column plus a Double Metaphone key
   actually buy, against real card names?
7. What do real card-name typos look like, and does anything about them change which
   mechanism fits?

## The answers

**Item 7 contradicts the premise the ticket inherited from
[#16](https://github.com/KeeprDigital/shop-keepr/issues/16).** Accents appear in **0.3%**
of real names — about 110 accented characters across all 38,001. Punctuation appears in
**21.6%** and **88.8%** of names are multi-token. There is also a hazard nobody named:
**100 names carry a character no customer can type** (`δ`, `◇`, `★`, `♀`, `®`).

**Item 6: two folded columns are worth 100%, and Double Metaphone is not typo tolerance.**

- `name_folded` **plus** `name_folded_nospace` takes dropped accents, deleted punctuation,
  punctuation-turned-to-space and smart quotes all to **100%**, at a **0.20%** collision
  cost. One key alone cannot: it trades "Farfetchd" against "Ho Oh" and tops out at 77%.
- Double Metaphone scores **90% on phonetic respelling and 85% on romanisation variants**
  — real value, since Bandai's `Kouzuki` and every player's `Kozuki` are different strings
  — but **22% on a QWERTY slip**. It is a phonetic mechanism and should not be sold as
  typo tolerance.
- **The largest failure category is not a typo at all.** Damerau-Levenshtein ≤ 2 scores
  2% and 0% on the two partial-recall classes; plain token-AND matching, which D1's FTS5
  already does, scores 83% and 100%.

## Run it

```bash
cd spike/typo-search
npm install
./fetch-data.sh          # re-fetch the four corpora (optional; data/ is committed)
node hazards.mjs             # item 7: hazard frequency, token lengths
node evaluate.mjs            # item 6: recall by error class, 11 mechanisms
node punctuation-probe.mjs   # the two-key fold result
```

## Layout

| File | What it is |
| --- | --- |
| `corpus.mjs` | Loads the four corpora and records each one's provenance. |
| `hazards.mjs` | Item 7. Hazard frequency, token-length distribution, apostrophe forms. |
| `mechanisms.mjs` | The fold rule, Double Metaphone keys, trigram sets, Damerau-Levenshtein. |
| `misspellings.mjs` | The thirteen error classes, and the honesty note about what they are. |
| `evaluate.mjs` | Item 6. Eleven mechanisms × thirteen classes, plus key-collision cost. |
| `punctuation-probe.mjs` | The naive fold vs the apostrophe-deleting fold vs two keys. |
| `data/` | The fetched corpora, and `all-card-names.json` — the merged 38,001. |

## What it cannot answer, and this is the important part

**Nobody has a query log for this application.** No figure here is a frequency of real
user behaviour. The error classes are mechanically defined and applied to real names, so
the **per-class recall numbers are real measurements of the mechanisms** — but the
**weights between classes are an assumption**. That is why the findings report every class
separately and refuse to quote a single weighted "coverage" number. The unweighted mean
printed by `evaluate.mjs` exists only so the columns can be compared, and says so.

The closest thing to a weight that *is* measured is exposure — how many of the 38,001
names can suffer each class at all — and `hazards.mjs` reports it.

**Two of the four corpora are qualified:**

- **Riftbound is a proxy.** No free Riftbound card list was reachable without registering
  for an API key, and this spike provisions nothing. Riot's Data Dragon champion names are
  the proper-noun vocabulary Riftbound is built on, so they stand in for the name *shapes*
  (`Kai'Sa`, `Rek'Sai`, `Nunu & Willump`). Any Riftbound percentage is a proxy figure.
- **Pokémon is a rate-limited sample** — 1,599 names from the 18 of 40 pages that
  `api.pokemontcg.io` returned unauthenticated.

Magic (Scryfall) and One Piece (Bandai's own English card list) are complete.
