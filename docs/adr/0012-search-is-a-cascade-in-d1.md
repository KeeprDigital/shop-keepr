---
status: accepted
---

# Card search is a five-tier cascade in D1, with typo tolerance per token

Card-name search runs inside the same D1 database as stock, as a strict cascade that stops at the first non-empty tier: folded-name exact → space-stripped folded exact → FTS5 token-AND → Double Metaphone token-AND → per-token trigram fuzzy-resolve of the failed tokens, then AND. All five tiers are issued as one `batch()` and the Worker takes the first non-empty result. The fold and metaphone rules ship as a small versioned library shop-keepr owns and applies at sync time; the Catalogue is not asked for folded columns or a search endpoint. Decided in [#24](https://github.com/KeeprDigital/shop-keepr/issues/24) on the measurements in [#25](https://github.com/KeeprDigital/shop-keepr/issues/25) and [#17](https://github.com/KeeprDigital/shop-keepr/issues/17).

The surprise this records: **"typo tolerance" was two requirements, and the larger one is not a typo.** Measured on 38,001 real card names, accents are 0.3 % of names while punctuation is 21.6 % and multi-token names 88.8 %. Partial recall (any-order token subset: `mind sculptor` → _Jace, the Mind Sculptor_) is the hard MVP requirement; keyboard slips are a fallback tier with a lower bar. Typo tolerance therefore attaches **per token**, not per query string, which is what lets it compose with partial recall and keeps the trigram table at vocabulary size (23,600 tokens) rather than name or Printing size.

## Considered options

**One folded key** — tops out at 77 %; two keys (`name_folded`, `name_folded_nospace`) reach 100 % on accent, punctuation and curly-quote classes at 0.2 % collision.

**Per-name or per-Printing trigrams** — 3× and 11× the rows of per-token, and unable to compose with token-subset matching.

**A hosted engine** — see ADR 0011; the co-location constraint decides it.

**Double Metaphone as the typo tier** — it is phonetic only (22 % on a keyboard slip); it stays as tier 4 for respellings and romanisations, never described as typo tolerance.

## Consequences

**Ranking is hand-rolled and rank-1 ordering is untested.** Every figure is recall. If ordering disappoints, the fix is a scoring function in D1 (`bm25()` on tier 3, length-normalised overlap on tier 5), not a new engine.

**An external-content FTS5 index does not follow its base table.** The sync module writes the index explicitly on every change; a write path that skips it leaves search silently stale.

**Never measure on a generated corpus.** A generated corpus overstated trigram cost 5.5×. The real corpus is `spike/typo-search/data/all-card-names.json`.

**A tuning lever is held in reserve**: querying only the five rarest trigrams per token cuts rows read 28× at some recall.
