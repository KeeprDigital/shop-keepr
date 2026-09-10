# shop-keepr

Glossary for the domain. Terms here beat synonyms; if code or an issue drifts to a different word, the code or the issue is wrong.

## Cards and stock

These three terms are a ladder, and confusing them is the most common mistake in this domain: a **Card** is the design, a **Printing** is a specific version of it, and a **SKU** is a Printing the store holds in a particular Condition.

**Game System** — a trading card game the store trades in. The store trades **Magic: The Gathering, Riftbound, One Piece and Pokémon**, and intends to trade as many further games as it can over time ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)). Which Game Systems appear to a customer is a store setting, not a fact about the Catalogue: the Catalogue carries games this store does not trade. Game Systems are never browsed together: a customer or staff member picks one first, because a Game System's attributes are meaningless in another. A card's colour means something in Magic and nothing in Pokémon.

**Catalogue** — the system of record for card data: every Card and Printing across every Game System it covers, **including each Printing's Market Price** ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)). It is external to shop-keepr, which consumes it and never writes to it — though it is a sibling project of ours, still under development, so what it carries is partly driven from here. Other systems consume the Catalogue too, and it is expected to grow more of them, so it knows nothing about stores, stock or prices a store sets. **The Catalogue asserts observations about a Printing — what is true of it regardless of who is asking; shop-keepr asserts policy — what this store does about them** ([ADR 0005](https://github.com/KeeprDigital/shop-keepr/blob/main/docs/adr/0005-catalogue-observes-shop-keepr-decides.md)). That is what decides which side a new field falls on, and it holds even though both projects are ours.

**Card** — a card as a design: the thing with a name. "Do we have any Luffys?" is a question about a Card. A Card is not something the store stocks or prices — it is what its Printings have in common, and shop-keepr uses it mainly to group search results.
_Avoid_ using "Card" for stock the store holds. That is a **SKU**.

**Printing** — a specific version of a Card, as the Catalogue defines it: a particular set, variation and finish. A Printing exists whether or not the store has ever held one, which is what makes it searchable before any stock does. A Printing's release region is a separate matter from its **Language**: two printings can share a region and differ in language, or the reverse.

**Mirror** — shop-keepr's own copy of the Catalogue, held so that every search, filter and sort runs locally. The Mirror holds no fact of its own: everything in it came from the Catalogue and can be rebuilt from it ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)). It is kept current by walking the Catalogue's changes; a Printing the Catalogue has **withdrawn** stays in the Mirror, flagged, and is never deleted — the kiosk no longer shows it, staff still see it and can still sell what they hold.
_Avoid_: cache, local catalogue.

**The Catalogue is the sole origin of a Printing**: shop-keepr never creates one and never constructs or parses a Printing's identity — it stores the identifier the Catalogue gave it, and treats it as opaque. A card staff cannot find is a gap in the Catalogue to be fixed there, not something worked around here. shop-keepr does not _interpret_ a Printing's attributes — it has no rules engine and no notion of legality or play — but it does store, index and display them.

**Facet** — an attribute of a Printing that a customer or staff member filters by, such as its set, rarity, colour or card type. Facets are chosen per Game System, because an attribute that means something in one game means nothing in another, and only a small number of a Printing's attributes are Facets: the rest are stored and shown but never filtered on. Which attributes are Facets is a shop-keepr decision about what the store needs to find, not a fact about the Catalogue ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)). Gameplay attributes such as a card's cost are not Facets, since nobody buys by them.

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

A Sell arrives by one of three routes and is the same thing whichever way: the kiosk (a fulfilled **Basket**), the **counter**, or a **Customer List**. A Buy arrives at the counter, as a **Large Buy**, or from a Customer List. At the counter, **lookup** comes first — *do we have this card, and how many* — and selling or buying is an action taken from what lookup found, adding the card to the sell side or the buy side of one draft ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11)). What was sold or bought is recorded at the price it was actually transacted for, alongside the price the store was asking or offering; there is no separate notion of a discount.

Every Transaction records its **net**: the money that actually moved at the till, from the store's perspective. It is the number the POS receipt shows and the one audit reconciles against; it is fixed when the Transaction is recorded and never recalculated.

**Trade** — a Buy and a Sell settled with one customer in one act, where the money that moves is the difference. A Trade is not a third kind of Transaction: it is a Buy and a Sell recorded together, each carrying the same net ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [ADR 0007](https://github.com/KeeprDigital/shop-keepr/blob/main/docs/adr/0007-trade-is-a-linked-buy-and-sell.md)). Whether a counter draft becomes a Buy, a Sell or a Trade depends only on which sides have cards in them.

**Large Buy** — a Buy too large for the counter, worked as a pile on its own screen: find each Printing, grade it, count it, next. It is a Buy in every other respect: it has a customer, prices per card, a POS Reference and a net. Buying stock from another dealer is a Large Buy, since money changed hands ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).

**Ingest** — loading the store's *own* stock, with no customer: the initial load of existing inventory, and afterwards any cards that arrive without a sale, such as a box found in the back room. Worked as a pile the same way a Large Buy is, but recorded as an **Adjustment** with a Reason and never priced. Cards can be typed in one at a time or imported from a file ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).
_Avoid_: intake, stock load.

**Adjustment** — a change to stock that is not a Transaction: a miscount, damage, shrinkage, cards found, or an **Ingest**. An Adjustment requires a **Reason** and is deliberately kept separate from buying and selling, so that stock changes with no customer can never be mistaken for trade.

## The kiosk

**Basket** — a customer's selection at the kiosk. Mutable while they shop: SKUs added and removed, quantities changed, a different Printing of the same Card chosen. A Basket is private to the kiosk until the customer **submits** it, at which point it joins the staff queue and receives a **Basket Number**; a customer cannot change it after that. A Basket is not itself a Transaction; on fulfilment it produces a **Sell** for whatever lines remain, since staff may **remove** a line they cannot sell. A Basket is `open`, `submitted`, `fulfilled`, `cancelled` or `expired`; staff may **revive** an expired Basket for a short while after ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).

**Basket Number** — the short number a customer quotes at the counter, issued when a Basket is submitted. Unique among the store's live Baskets and reused after; deliberately not sequential, so it says nothing about how busy the shop is. It is a handle for people, not an identity for the system.

**Hold** — a reservation against a SKU, created when that SKU is added to a Basket and released when the line is removed or the Basket ends. A Hold has no clock of its own: **the Basket carries the expiry, and every Hold in it expires together** ([ADR 0006](https://github.com/KeeprDigital/shop-keepr/blob/main/docs/adr/0006-basket-owns-the-hold-clock.md)). The period is a store setting, reset by the customer's activity and never extended by hand. Available quantity is on-hand minus active Holds.

## Prices

**Market Price** — a Printing's going rate in the market, **supplied by the Catalogue** ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)). It attaches to the Printing, not to a SKU: one rate per Printing, from which per-Condition and per-Language prices are derived. Not set by the store. **Visible to staff and never to a customer**: it is an input to the store's own prices, not a price anyone is offered.

**Sell Price** — what the store asks for a SKU. Derived from the Printing's Market Price by the store's **Pricing Rules**, and overridable by a Pinned Price. This is the only price a kiosk customer ever sees.

**Buy Price** — what the store pays for a SKU. Derived from the Printing's Market Price by the store's **Pricing Rules**, independently of the Sell Price and with its own settings throughout. Quoted for any Printing, including ones the store has never held.

**Pricing Rules** — the store's own rules for turning a Market Price into a Sell Price and a Buy Price. They are the store's commercial policy, not a property of any card: the store decides what a Lightly Played copy is worth to it, what it pays for a rare, and what it will never sell below. Rules may be set per Game System, and any rule a Game System does not set falls back to the store's defaults ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [ADR 0004](https://github.com/KeeprDigital/shop-keepr/blob/main/docs/adr/0004-configurable-pricing-pipeline.md)).

**Pricing Attribute** — an attribute of a Printing that Pricing Rules key on — rarity, most often, and whatever else a Game System prices by. Attributes belong to the Catalogue and their values differ from game to game; shop-keepr does not interpret them, it only matches on them.

**Modifier** — a fixed amount of money a Pricing Rule adds for a Pricing Attribute value, separately for Sell and for Buy. Every matching Modifier applies.

**Floor** — the lowest price the store will accept, below which a calculated price is replaced rather than adjusted. Set per Game System and per Pricing Attribute value; where several apply, the highest holds, since each is a promise not to go lower.

**Pinned Price** — a price a person has fixed by hand, which the Pricing Rules leave alone however far the Market Price moves. Sell and Buy are pinned independently, and a pin attaches to a SKU: it is a statement about a card in a given Condition and Language, not about the Printing. It records who pinned it and when. A pin is a decision, not a state: it stands until someone clears it, and staff are alerted about pins that may have gone stale — never by changing the price.

## Other

**Store** — the business shop-keepr runs for. One today; every record is scoped to a Store. A Store has settings of its own: its trading currency and default **Language**, its Hold expiry period, and its Pricing Rules in full.

**POS Reference** — the external point-of-sale system's own identifier for a sale, attached to a Transaction. **Every Buy and every Sell carries one**; it is the only thread between cards moving here and money moving through the till ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)). shop-keepr does not integrate with the POS and treats this as an opaque string. Adjustments never have one.

**Buylist** — a list of cards the store specifically wants, at fixed prices. Defined here so the term is not used loosely for anything else. Out of scope for the MVP.

**Customer List** — a list of cards a customer supplies, however it arrives: pasted text today, an email or a photo later. It is the customer's list, where a Buylist is the store's. A list is for one Game System and goes one way — a Buy or a Sell — decided before it is read; a customer who is selling some cards and wants others has two lists. Staff resolve each line to a Printing, or drop it, and a line that could be several Printings is never guessed at. A list is not a Basket and not a Transaction: it holds no stock and fixes no price while it waits, and it produces one Transaction when it is complete — a Sell directly, or a Large Buy where the cards are graded ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).
_Avoid_: pasted list, want list, buylist.
