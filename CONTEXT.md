# shop-keepr

Glossary for the domain. Terms here beat synonyms; if code or an issue drifts to a different word, the code or the issue is wrong.

## Cards and stock

**Game System** — a trading card game the store trades in. The Catalogue currently covers One Piece, Dragon Ball Fusion World, Digimon and Gundam, with Riftbound in progress; whether the store also trades games the Catalogue does not carry is an open question ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)). Game Systems are never browsed together: a customer or staff member picks one first, because a Game System's attributes are meaningless in another. A card's colour means something in Magic and nothing in Pokémon.

**Catalogue** — the system of record for card data: every Printing across every Game System it covers. It carries **no prices**. It is external to shop-keepr, which consumes it and never writes to it. Other systems consume the Catalogue too, so it knows nothing about stores, stock or prices a store sets.

**Printing** — a card as the Catalogue defines it, identified by the Catalogue's own identifier: a specific card in a specific set, variation, finish and language. A Printing exists whether or not the store has ever held one, which is what makes it searchable before any stock does. shop-keepr does not _interpret_ a Printing's attributes — it has no rules engine and no notion of legality or play — but it does store, index and display them.

**Card** — a Printing together with a Condition, that the store holds or transacts. Four Near Mint copies and one Lightly Played copy of the same Printing are two Cards, each with its own quantity and its own prices. Staff say "card" for both a Printing and the stock the store holds of it; where the difference matters, use the precise term.

**Condition** — the physical grade of a Card: Near Mint (NM), Lightly Played (LP), Moderately Played (MP), Heavily Played (HP), Damaged (DMG). One scale, used across every Game System the store trades in.

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

**Market Price** — a Card's going rate in the market. **Its source is undecided**: the Catalogue supplies none ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)). Not set by the store, and never shown to a customer: it is an input to the store's own prices, not a price anyone is offered.

**Sell Price** — what the store asks for a Card. Derived from Market Price by a rule, and overridable. This is the only price a kiosk customer ever sees.

**Buy Price** — what the store pays for a Card. Derived from Market Price by a buy percentage.

## Other

**Store** — the business shop-keepr runs for. One today; every record is scoped to a Store.

**POS Reference** — the external point-of-sale system's own identifier for a sale, attached loosely to a Transaction. shop-keepr does not integrate with the POS and treats this as an opaque string.

**Buylist** — a list of cards the store specifically wants, at fixed prices. Defined here so the term is not used loosely for anything else. Out of scope for the MVP.
