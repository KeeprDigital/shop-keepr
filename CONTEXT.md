# shop-keepr

Glossary for the domain. Terms here beat synonyms; if code or an issue drifts to a different word, the code or the issue is wrong.

## Cards and stock

**Card** — a card the store holds or transacts. Identified by the card API's identifier together with its **Condition**: four Near Mint copies and one Lightly Played copy of the same printing are two Cards, each with its own quantity and its own prices. Staff say "card" both for a printing and for the stock the store holds of it; shop-keepr models only the latter, because printing identity belongs to the card API and not to this system. A Card absorbs printing, variation, finish and language — none of which shop-keepr interprets.

**Condition** — the physical grade of a Card, on the near-universal Magic: The Gathering scale: Near Mint (NM), Lightly Played (LP), Moderately Played (MP), Heavily Played (HP), Damaged (DMG).

## Cards moving

**Transaction** — cards going into or out of the system. Always stated **from the store's perspective**, and always one of two types:

- **Buy** — the store buys cards from a customer. Stock in.
- **Sell** — the store sells cards to a customer. Stock out.

The perspective matters and inverts at the kiosk: a customer buying a card produces a **Sell**.

**Adjustment** — a correction to stock that is not a Transaction: a miscount, damage, shrinkage, or cards found. An Adjustment requires a **Reason** and is deliberately kept separate from buying and selling, so that stock corrections can never be mistaken for trade.

## The kiosk

**Basket** — a customer's selection at the kiosk. Mutable while they shop: cards added and removed, quantities changed, a different version of a card chosen. A Basket is not itself a Transaction; on fulfilment it produces a **Sell**.

**Hold** — a time-limited reservation against a Card, created when that Card is added to a Basket. It expires after a store-configurable period. Available quantity is on-hand minus active Holds.

## Prices

**Market Price** — a Card's price as supplied by the card API. Not set by the store.

**Sell Price** — what the store asks for a Card. Derived from Market Price by a rule, and overridable.

**Buy Price** — what the store pays for a Card. Derived from Market Price by a buy percentage.

## Other

**Store** — the business shop-keepr runs for. One today; every record is scoped to a Store.

**POS Reference** — the external point-of-sale system's own identifier for a sale, attached loosely to a Transaction. shop-keepr does not integrate with the POS and treats this as an opaque string.

**Buylist** — a list of cards the store specifically wants, at fixed prices. Defined here so the term is not used loosely for anything else. Out of scope for the MVP.
