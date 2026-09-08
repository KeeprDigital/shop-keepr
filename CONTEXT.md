# shop-keepr

Glossary for the domain. Terms here beat synonyms; if code or an issue drifts to a different word, the code or the issue is wrong.

## Cards and stock

These three terms are a ladder, and confusing them is the most common mistake in this domain: a **Card** is the design, a **Printing** is a specific version of it, and a **SKU** is a Printing the store holds in a particular Condition.

**Game System** — a trading card game the store trades in. The store trades **Magic: The Gathering, Riftbound, One Piece and Pokémon**, and intends to trade as many further games as it can over time ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)). Which Game Systems appear to a customer is a store setting, not a fact about the Catalogue: the Catalogue carries games this store does not trade. Game Systems are never browsed together: a customer or staff member picks one first, because a Game System's attributes are meaningless in another. A card's colour means something in Magic and nothing in Pokémon.

**Catalogue** — the system of record for card data: every Card and Printing across every Game System it covers. Whether it supplies Market Price is undecided ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)). It is external to shop-keepr, which consumes it and never writes to it — though it is a sibling project of ours, still under development, so what it carries is partly driven from here. Other systems consume the Catalogue too, so it knows nothing about stores, stock or prices a store sets.

**Card** — a card as a design: the thing with a name. "Do we have any Luffys?" is a question about a Card. A Card is not something the store stocks or prices — it is what its Printings have in common, and shop-keepr uses it mainly to group search results.
_Avoid_ using "Card" for stock the store holds. That is a **SKU**.

**Printing** — a specific version of a Card, as the Catalogue defines it: a particular set, variation and finish. A Printing exists whether or not the store has ever held one, which is what makes it searchable before any stock does. A Printing's release region is a separate matter from its **Language**: two printings can share a region and differ in language, or the reverse.

**The Catalogue is the sole origin of a Printing**: shop-keepr never creates one and never constructs or parses a Printing's identity — it stores the identifier the Catalogue gave it, and treats it as opaque. A card staff cannot find is a gap in the Catalogue to be fixed there, not something worked around here. shop-keepr does not _interpret_ a Printing's attributes — it has no rules engine and no notion of legality or play — but it does store, index and display them.

**SKU** — a Printing in a given **Condition** and **Language**, held by one Store. This is the unit the store counts, prices, holds and transacts: four Near Mint copies and one Lightly Played copy of the same Printing are two SKUs, each with its own quantity and its own prices.

A SKU is arrived at rather than named: staff find the Printing, then apply the Condition. It is a store-system term and **not** something anyone says on the shop floor — where staff say "card", they mean a Card or a Printing, and the precise term is for code and specs.

**Condition** — the physical grade of a SKU: Near Mint (NM), Lightly Played (LP), Moderately Played (MP), Heavily Played (HP), Damaged (DMG). One scale, used across every Game System the store trades in.

**Language** — the language a SKU is printed in, recorded as a BCP 47 tag from a controlled list (`en`, `ja`, `ko`, `fr`, `de`, `it`, `es`, `es-ES`, `es-419`, `pt-BR`, `zh-Hans`, `zh-Hant`, and `x-phyrex` for Magic's Phyrexian printings). Language belongs to the SKU and not to the Printing: the Catalogue describes a Card in one language, and the store records which language the copies it holds are actually in.

Every Store has a **default Language** for its region, so staff set a language only when a card differs from it. The bet behind this is that non-default-language stock stays rare; if it stops being rare, language belongs on the Printing instead and existing stock has to move.

## Cards moving

**Transaction** — cards going into or out of the system. Always stated **from the store's perspective**, and always one of two types:

- **Buy** — the store buys cards from a customer. Stock in.
- **Sell** — the store sells cards to a customer. Stock out.

The perspective matters and inverts at the kiosk: a customer buying a card produces a **Sell**.

**Adjustment** — a correction to stock that is not a Transaction: a miscount, damage, shrinkage, or cards found. An Adjustment requires a **Reason** and is deliberately kept separate from buying and selling, so that stock corrections can never be mistaken for trade.

## The kiosk

**Basket** — a customer's selection at the kiosk. Mutable while they shop: SKUs added and removed, quantities changed, a different Printing of the same Card chosen. A Basket is not itself a Transaction; on fulfilment it produces a **Sell**.

**Hold** — a time-limited reservation against a SKU, created when that SKU is added to a Basket. It expires after a store-configurable period. Available quantity is on-hand minus active Holds.

## Prices

**Market Price** — a Printing's going rate in the market. It attaches to the Printing, not to a SKU: one rate per Printing, from which per-Condition prices are derived. **Its source is undecided**: the Catalogue supplies none today, and whether it should is part of the open question ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)). Not set by the store, and never shown to a customer: it is an input to the store's own prices, not a price anyone is offered.

**Sell Price** — what the store asks for a SKU. Derived from the Printing's Market Price by a rule that takes Condition into account, and overridable. This is the only price a kiosk customer ever sees.

**Buy Price** — what the store pays for a SKU. Derived from the Printing's Market Price by a buy percentage, likewise taking Condition into account.

## Other

**Store** — the business shop-keepr runs for. One today; every record is scoped to a Store. A Store has settings of its own, including its default **Language** and its Hold expiry period.

**POS Reference** — the external point-of-sale system's own identifier for a sale, attached loosely to a Transaction. shop-keepr does not integrate with the POS and treats this as an opaque string.

**Buylist** — a list of cards the store specifically wants, at fixed prices. Defined here so the term is not used loosely for anything else. Out of scope for the MVP.
