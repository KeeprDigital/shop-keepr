# What shop-keepr requires of the Catalogue

The Catalogue is [`KeeprDigital/card-keepr`](https://github.com/KeeprDigital/card-keepr), a sibling project under the same ownership. There is no negotiation between the two: shop-keepr states requirements and card-keepr schedules them. This file is where those requirements live, so the whole demand shop-keepr places on the Catalogue can be read as one set — which is what catches two requirements that overlap or contradict.

Requirements are filed as issues on card-keepr when it schedules the work. This file is the source; the issues are the scheduling surface.

The boundary that decides what belongs here at all is [ADR 0005](adr/0005-catalogue-observes-shop-keepr-decides.md): the Catalogue asserts observations about a Printing, shop-keepr asserts policy. A requirement that asks the Catalogue to hold a shop-keepr policy is a requirement to reject.

## Contract

**Change delivery: one paged endpoint per Game System, walked by an opaque cursor.** Every record shop-keepr mirrors — Printings, sets, vocabularies — is reachable through a paged endpoint ordered by a cursor the Catalogue issues. The cursor is **opaque** (shop-keepr stores and returns it verbatim, never parses it), **monotonic**, and **exhaustive**: nothing with a change at or before a cursor is ever returned after it. Walking from cursor zero returns everything, which is how shop-keepr seeds and reconciles; walking from a stored cursor returns what changed since. The Catalogue may back the cursor with a timestamp and a tiebreak, or a commit sequence; shop-keepr does not care which. No snapshot artefact or Revision is consumed ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md)).

**Withdrawal arrives as a record, never as absence.** A Printing removed from the Catalogue is returned by the walk flagged `withdrawn`, with a change cursor like any other change. shop-keepr keeps the row and flags it; it never infers withdrawal from a record failing to appear ([ADR 0005](adr/0005-catalogue-observes-shop-keepr-decides.md) places lifecycle Catalogue-side).

**Market Price per Printing, on the Printing record and on its own change walk.** One rate per Printing. The Printing record carries its current Market Price and the cursor at which the price last moved, so a new Printing arrives priced. A second walk, on the same cursor rules, returns only price movements, so shop-keepr can refresh prices on a cadence of its own without re-reading card facts ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)). Not per-Condition and not per-Language — those are shop-keepr's policy ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [ADR 0005](adr/0005-catalogue-observes-shop-keepr-decides.md)).

**Per-game Pricing Attributes, matchable by rule.** Attributes of a Printing that pricing rules key on — rarity most often, and whatever else a Game System prices by. They must be matchable per game without shop-keepr interpreting them ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), a schema input to [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)).

**Per-game Facet attributes on every Printing.** shop-keepr filters a Printing by a small set of attributes chosen per Game System ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)), and each must be present on the exported record in a form shop-keepr can extract without interpretation. The MVP set: set and rarity for every game; **Magic** colour identity, card type and finish; **Pokémon** card kind, energy type, stage and variant; **One Piece** colour and card type; **Riftbound** domain and card type. Multi-valued attributes (colour identity, colour, domain) as a list of codes, not a joined string. Every other attribute is stored verbatim and rendered, never filtered on, so the full record must be exported — a later Facet is promoted from the stored record, not re-fetched.

**A Card identifier on every Printing.** Results group by Card ("do we have any Luffys?"), which is a query over Printings sharing a `card_id`, not a Card table ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).

**Per-game vocabularies exported as records.** Sets (code, display name, release date) and the value lists a Facet draws from — rarities, colours, card types, variants — each as code, display name and sort order, per Game System. shop-keepr's filter controls read these rather than hardcoding a rarity name or scanning Printings for distinct values ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)). Adding a value to a vocabulary is a normal Catalogue change; shop-keepr fails sync loudly only where a value needs a column of its own (a new colour), and passes everything else through.

**Stable, CDN-served image URLs on every Printing**, in at least two sizes — a thumbnail for lists and a full image for detail — and one URL per face for multi-faced Printings. shop-keepr renders from the Catalogue's host and stores nothing ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)); a URL that changes or expires breaks the kiosk.

**A generated OpenAPI document, served at a stable path in every environment.** Generated from the implementation rather than hand-maintained, so it cannot drift from what the API does. Served per environment so "which contract is staging running?" is answerable rather than assumed. shop-keepr commits a fetched copy, making contract change visible as a reviewable diff.

**The document describes the walked records as well as the routes.** Record shapes are part of the same OpenAPI document, not a separate artefact, so one committed file and one generator cover everything shop-keepr consumes. shop-keepr generates its types *and* its runtime validators from it and validates every pulled record against them ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).

## Access

**Per-consumer identity, not a shared secret.** A `Consumer` record with API keys hanging off it, scopes, and rate limits keyed on the consumer. shop-keepr is Consumer #1. Filed as [card-keepr#269](https://github.com/KeeprDigital/card-keepr/issues/269); the reasoning is in [#23](https://github.com/KeeprDigital/shop-keepr/issues/23).

**A credential for shop-keepr, per environment.** Four of them: local, dev, staging, production.

## Environments

**Dev, staging and production, each independently addressable.** shop-keepr's integration tests gate merges against **staging**, because staging is the consumer-facing environment: pinned to a deliberate commit and stable enough that a failure means shop-keepr's bug. Dev is the Catalogue's own inner loop and is not a test target for a consumer. Production never appears in an automated test.

## Coverage

**Magic: The Gathering and Pokémon.** Two of the four Game Systems the store trades ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)). This is supply, not contract: [#22](https://github.com/KeeprDigital/shop-keepr/issues/22) settled that shop-keepr does not gate on Catalogue coverage and carries no code assuming a particular game exists. It belongs on the Catalogue's own roadmap and does not block shop-keepr's build.
