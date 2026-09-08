---
status: accepted
---

# Pricing is a configurable ordered pipeline, not a fixed formula

A Sell or Buy Price is produced by folding an **ordered list of steps** over the Market Price, where both the steps' values and their order are store configuration. The steps come from a closed set — `x FX`, `x condition multiplier`, `x language multiplier`, `x percentage`, `+ modifiers`, `round`, `floor` — and every value in them resolves down a chain: attribute row, then Game System rules, then store defaults. Decided in [#8](https://github.com/KeeprDigital/shop-keepr/issues/8).

The surprise this records: **there is no pricing formula in the codebase to read.** Someone looking for the arithmetic will find an evaluator and a table of steps, and the arithmetic that actually priced a card lives in the store's settings. That is deliberate, and it is not a missing abstraction to collapse.

## Considered options

**One hardcoded formula.** `market x fx x condition x language x percentage`, with the percentages configurable and nothing else. Simplest to build, simplest to test, and the version every reader expects. Rejected because the store's requirements already exceed it: a flat money modifier per rarity, a floor that varies by rarity, percentages banded by card value, and rounding direction per side. Each of those arrives as a new branch in one function, and the function becomes an unordered pile of `if`s whose behaviour nobody can state — which is the same pipeline, written worse and not configurable.

**An expression language.** Let the store write `market * 0.78 * cond + 0.5`. Maximum flexibility, and rejected on it: an input that can express anything can express something that does not compute, and the failure lands on a shelf price. It also puts a parser, a sandbox and a syntax error message in front of a shop owner who wants to charge 5% more for rares.

**An ordered fold over a closed step set.** Chosen. The steps are enumerated, so nothing can be configured that does not evaluate; the order is data, so a store that wants to floor before rounding does not need a release. The evaluator is one function used by every caller — the sweep, the Buy counter, the kiosk — so a price is the same number wherever it is asked for.

**All-or-nothing rule sets per Game System.** Considered while designing the resolution chain: a Game System either configures everything or inherits everything. Rejected as a worse fit for the actual work — a store setting a Magic rare modifier should not have to restate its condition multipliers to do it. Resolution is therefore **per setting**, not per rule set.

## Consequences

**Four orderings are invariants, not preferences.** FX applies first, because every band, modifier and floor downstream is a store-currency figure. Band lookup precedes the percentage step, because it selects the percentage. Bands key on the converted Market Price, never on the running total, or the input depends on the output. And rounding runs before the floor by default: reverse them and a 50p floor rounds down to 40p, defeating the one thing a floor exists to do. The first three are enforced; the fourth is configurable and is the trap.

**The settings page is a real surface, not two text boxes.** Rules per Game System, attribute rows, bands, condition and language multipliers, rounding per side, floors, and the step order itself. That is the cost of this decision, paid once, in the MVP.

**Every matching Modifier applies; the highest Floor wins.** Two attribute rows matching one card (rare *and* foil) sum their modifiers, because both are true statements about the card. Their floors do not sum — each floor is a promise not to go below a number, and only the highest keeps both promises.

**A rule edit reprices the store.** Prices are stored columns on the SKU ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6)), so changing configuration means a sweep: queue-backed, chunked by cursor, idempotent, resumable, one job per store, never inside a request. It is scoped to SKUs with stock on hand or a pin, so its cost tracks what the store holds rather than every SKU it has ever touched. Pinned prices are skipped by definition.

**Nothing records which rules produced a price.** No rule versioning, no history: the price is the price, and what a customer actually paid is snapshotted on the Transaction ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)). The cost is that a price cannot be explained after a rule has changed, only recomputed under the rules in force now. Accepted deliberately.

**Pricing now depends on Catalogue attributes being queryable.** A rule keying on rarity needs rarity present and matchable in the mirror, per Game System. That is a requirement shop-keepr places on the Catalogue ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)) and on the mirror's schema ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)) — search is no longer the only consumer of that shape.

**Revisit if a store needs rules that are not a fold.** Anything conditional on two attributes at once, on stock age, or on a competitor's price is outside this shape. The escape hatch until then is the Pinned Price, which is a decision by a person and answers to no rule.
