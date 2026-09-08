---
status: accepted
---

# Stock is an append-only ledger, corrected by compensating entries

Stock levels are derived from an append-only ledger of Buys, Sells and Adjustments rather than stored as a mutable quantity per SKU. Rows are never edited or deleted: a staff mistake is corrected by appending a new entry with opposite quantities and a `reverses` pointer to the original, carrying its own Reason. Decided in [#7](https://github.com/KeeprDigital/shop-keepr/issues/7).

## Considered options

**Mutable quantities** — a single number per SKU, updated in place. Rejected: it destroys the history the store needs to answer "how did we end up with four of these", and every reporting question later becomes unanswerable rather than merely unbuilt.

**Append-only with a `voided` flag** — the correction marks the original as void, and derivation skips voided entries. Rejected on four counts, and this is the option a future reader is most likely to reach for:

1. It breaks the property it claims to preserve. Append-only means rows never change after insert; a void flag changes a row after insert. That is mutable state presenting itself as immutable, which is worse than plain mutable state because everything downstream trusts the guarantee.
2. It makes correctness opt-in for every future query. Once the flag exists, every query touching stock must remember `WHERE NOT voided` — the on-hand projection, the reconcile job, reports, exports, code not yet written. Missing it produces silently wrong numbers with no error. With compensating entries there is nothing to remember: corrections are ordinary rows, so every query is correct by construction.
3. It loses the audit that compensating entries get for free. A new entry carries the same `created_at`, `surface` and `session_id` as any other. A void flag knows only that something was voided, and recovering when and by whom means adding `voided_at`, `voided_by`, and so on — reinventing the entry you could have written.
4. It cannot express partial corrections. A customer returning 2 of 4 cards is an ordinary entry under compensation, and impossible under an all-or-nothing flag.

## Consequences

**A reversal carries the same `kind` as the entry it reverses.** Reversing a Buy moves stock out and so resembles a Sell, but recording it as a Sell would put money nobody paid into the sales figures. A reversed Buy is a Buy with negative quantities.

**History shows two rows where a reader expects one.** This is a presentation problem, solved in the UI: staff press "Undo this Buy" and see the original greyed with a "reversed" chip linking to its reversal. The word "compensating" never reaches the shop floor.

**On-hand is a materialised projection, not a scan** ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2)), so two representations of one fact can drift. A reconcile job recomputes the ledger sum per SKU, heals `on_hand` to match, and logs every heal to a `projection_drift` table — correct on the shop floor within the hour, with the evidence preserved rather than overwritten. A heal is never itself a ledger entry: it repairs a derived number and must not inject business events that never happened.

**Available-to-promise is computed on read**, never stored: `on_hand` minus active Holds. Storing it would force a write on every hold expiry, which the lazy-expiry design in [#4](https://github.com/KeeprDigital/shop-keepr/issues/4) exists to avoid.

**Ledger lines carry descriptive text** — card name, number, set and rarity as plain text at the time of the entry — duplicating the mirror deliberately. The ledger is permanent while the mirror is rebuilt, so a line holding only references becomes unreadable if a printing changes or a rebuild drops a row.
