---
status: accepted
---

# Language belongs to the SKU, not the Printing

A SKU is a Printing in a given Condition **and Language**, and Language is recorded by the store rather than supplied by the Catalogue. Language is part of SKU identity, stored as a BCP 47 tag from a controlled list, defaulted from a store-level setting resolved at write time. Decided in [#7](https://github.com/KeeprDigital/shop-keepr/issues/7).

## Considered options

**Language as a Printing dimension** — a language variant is a distinct Printing, so the store picks the Japanese printing exactly as it picks an alt art, and the SKU needs no language at all. Conceptually cleaner, and it removes a column, a store setting and a class of duplicate-stock bugs outright.

Rejected because it makes the entire Catalogue carry a language dimension for every card in every game in order to serve a case this store expects to be rare, and because the store then cannot record a language the Catalogue has not yet covered — a customer presenting a Japanese card could not be traded with until the Catalogue caught up. Confining the cost to the rare rows is proportionate; making every card in every game ten rows is not.

**A hybrid** — language on the Printing, overridable on the SKU. Rejected on sight: two sources of truth for one fact, and the identity ambiguity returns.

## Consequences

**This is a bet on rarity, and it has an exit.** If non-default-language stock stops being rare, language belongs on the Printing after all, and moving it means re-pointing existing stock *and its ledger history* at different printings. The append-only ledger makes that fiddlier than a normal migration. Recorded here so that whoever reaches that point knows it was a deliberate bet rather than an oversight.

**Non-English stock displays English card data.** The Catalogue holds one Printing per card, so the name, rules text and image all come from it. A Japanese copy shows English artwork with a language label attached. Staff will read it correctly; a kiosk customer may not.

**Non-English stock is priced by hand.** Market Price attaches to the Printing and knows nothing about language, while a Japanese card is often worth materially more or less than its English equivalent. The pricing rule will be wrong for these and staff will override it. Whether language becomes a rule input is [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)'s call.

**Every write path must set Language consistently, forever.** Language is in the SKU key, and in SQLite a `NULL` is distinct from every other `NULL` in a unique index — so a nullable column would fail open on the ~99% of rows that carry no explicit language, silently splitting one pile of stock into several. The column is therefore `NOT NULL`, and one shared normalisation rule at the write boundary maps blank, absent and the store default to a single canonical tag. This is the ongoing discipline the decision costs: a new screen that skips that rule reintroduces duplicate SKUs quietly.

**Release region is separate from Language.** Two `en` printings can differ by release region; region never stands in for a language tag.
