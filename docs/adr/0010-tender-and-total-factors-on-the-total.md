---
status: accepted
---

# Tender and whole-Transaction factors act on the total and are snapshotted on the header

A Buy's lines are always priced in the store's Default Tender. Settling in the other Tender, and any Total Percentage staff apply, are factors on the Transaction's **total**, never rewritten onto its lines, and the header records them as applied — `tender`, `tender_modifier_pct`, `total_pct`, and on a Trade `remainder_tender` — beside `net`. Decided in [#43](https://github.com/KeeprDigital/shop-keepr/issues/43), settling the shape [#27](https://github.com/KeeprDigital/shop-keepr/issues/27) found.

## Considered options

**Two Buy Prices per SKU, one per Tender.** The pipeline emits a cash price and a credit price; each line carries both. Rejected: it doubles every stored price column and every sweep for one store-wide percentage, and it makes a Trade's split (part credit, part cash) a per-line allocation problem with no right answer for the line in the middle.

**Spread the factor across the lines.** Rewrite each transacted price so the lines sum to the net. Rejected: a line's transacted price is what *that card* was bought for, and it already carries a per-line override (#11); a whole-Buy haggle is not a statement about any card. Spreading also makes the same card's history read differently depending on what else was in the pile.

**Record nothing, let the gap speak.** Keep `net` and infer the factor from the difference to the line sum. Rejected: the ledger is append-only and settings move, so a gap seen at audit could be a modifier, a percentage, a rounding, or a bug, and nothing says which. [ADR 0004](./0004-configurable-pricing-pipeline.md) accepts that a *price* cannot be explained after a rule change; a *transacted term* has the standing of a transacted price and is snapshotted for the same reason.

**A third tender value, `split`, for a Trade paid partly in cash.** Rejected: a Trade's Buy is credit for the Covered part by definition, so the only choice is how the Remainder is paid; one nullable `remainder_tender` says that, and `tender` keeps a two-value domain.

## Consequences

**`net` is a computed snapshot, not a sum.** `round(Σ transacted × tender factor × (1 + total_pct))`, rounded once, last, by the side's rounding rule from the pipeline. Anyone summing lines to check a Buy will be off by the factors; the header says by how much and why.

**A line never learns which Tender paid for it.** Reporting that wants "what did we pay in cash for this card" must apply the header's factor; that is the price of lines that read the same whatever pile they were in.

**A Trade Buy with a cash Remainder is one Buy with two effective tenders.** Its `net` is `−K × (1 − S/C)` (K and C the pile's cash and credit values, S the Sell total). A partial reversal is a compensating entry with its own net, per [ADR 0001](./0001-append-only-ledger.md); no finer rule is given until one is needed.

**The counter Sell gains a Total Percentage**, reversing [#31](https://github.com/KeeprDigital/shop-keepr/issues/31)'s "no total-level discount" on the grounds it named for revisiting: it was asked for, by symmetry with the Buy.
