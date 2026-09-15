---
status: accepted
---

# The Catalogue mirror is two read models, split by who reads them

The mirror holds every Printing twice: once in a shared `printing` table that carries identity and display fields and nothing game-specific, and once in a search table per Game System (`mtg_printing`, `pokemon_printing`, …) that carries that game's typed facet columns _plus_ the name, folded-name, set, number and Market Price columns a game-scoped filter-and-sort needs in one index. Stock, the ledger, Baskets and repricing read only `printing`; search reads only the per-game tables; one sync module writes both from the same Catalogue record. Decided in [#15](https://github.com/KeeprDigital/shop-keepr/issues/15).

## Considered options

**One wide table, sparse per-game columns** — what the [#13](https://github.com/KeeprDigital/shop-keepr/issues/13) spike measured, and it performs identically: every index leads with `game_system`, so a game-scoped browse reads 60 rows either way. Rejected on code clarity, which [#15](https://github.com/KeeprDigital/shop-keepr/issues/15) named as the only criterion besides performance: four games put roughly thirty mostly-null columns on every row, twenty games put a hundred and fifty, every index for one game's facets carries every other game's rows, and every reader has to know which columns mean anything for which game. Not on ease of extension, which [#22](https://github.com/KeeprDigital/shop-keepr/issues/22) ruled out as a reason.

**Per-game tables only, no shared table** — the purest per-game shape. Rejected because a Basket, a ledger, an Intake pile and the kiosk queue all hold Printings from any game, and rendering them would be a `UNION` across N tables. D1 caps a compound `SELECT` at five members ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13)), so the fifth game would break every cross-game screen.

**Shared core plus per-game extension tables holding only the facets** — rejected because a facet filter and a name or price sort must share one physical index ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), measured in [#13](https://github.com/KeeprDigital/shop-keepr/issues/13)), which a join across two tables cannot provide. The per-game search table therefore carries its own copy of the sort keys, which is what makes this decision two read models rather than one table with extensions.

**A generic key/value attribute projection** — rejected on the [#13](https://github.com/KeeprDigital/shop-keepr/issues/13) measurement: the shape D1's planner handles worst, 112,803 rows read to return nothing.

## Consequences

**Neither table holds a fact of its own.** Both are derived from the Catalogue and rebuildable by re-seed, so the two cannot drift in any way a re-seed does not repair. The sync module is the only writer of either.

**Market Price is written twice** on every price pull: to `printing` for repricing and to the game's search table for price-sorted browse.

**Search code is the only code that knows a per-game table exists.** Each Game System is a module owning its table, its facet columns, its index set, its colour-to-column mapping and its registry of pricing-capable attributes. Nothing outside search imports it. Adding a Game System is a module, a migration and a registry entry — the rare, planned release [#22](https://github.com/KeeprDigital/shop-keepr/issues/22) allowed for.

**Adding a facet to a game is one migration on one table**, extracting a value already held in that Printing's stored record, with no Catalogue round-trip.

**Inventory filtered by facet is still unsolved**, deliberately: "my Magic stock, blue only, cheapest first" drives from stock, which has no facet columns, and is the empty-facet tail [#13](https://github.com/KeeprDigital/shop-keepr/issues/13) measured. Its fix is a third derived copy of facets onto stock, not a change to this decision, and it is not for the MVP.

**Collapsing to one wide table later is a sync-module change and a migration**, because no reader outside search would notice.
