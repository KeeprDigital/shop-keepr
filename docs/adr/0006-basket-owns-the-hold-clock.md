---
status: accepted
---

# The Basket owns the expiry clock, not the Hold

A Hold is created when a SKU is added to a Basket, but it has no clock of its own: the Basket carries one `expires_at`, every Hold in it inherits that instant, and customer activity on the Basket resets it. Availability is still one query, on-hand minus the Holds whose Basket has not expired. Decided in [#10](https://github.com/KeeprDigital/shop-keepr/issues/10).

## Considered options

**A clock per Hold** — what the glossary said and what the reservation spike in [#4](https://github.com/KeeprDigital/shop-keepr/issues/4) modelled: each Hold row carries its own `expires_at`, set when the SKU is added. Simplest row shape, and the spike's single-statement reservation reads it directly.

Rejected because a Basket built over several minutes then lapses one line at a time, first item first, while the customer is still shopping or standing at the counter. Resetting every Hold on every action recovers the right behaviour but is the Basket clock written out N times, with N chances to miss one.

**Both** — a Basket clock plus a per-Hold clock, the earlier winning. Rejected on sight: two sources of truth for one fact.

## Consequences

**A Basket is the unit that expires; a Hold is never released alone by time.** Holds leave singly only when a line is removed, by the customer while shopping or by staff at the pick.

**Every non-terminal Basket has a clock, including `open` ones the kiosk idle reset will cancel long before it fires.** The invariant is kept without a special case so that the availability query and the sweeper never need to know which state a Basket is in.

**The reservation statement joins to the Basket.** [#4](https://github.com/KeeprDigital/shop-keepr/issues/4)'s conditional insert compared `hold.expires_at`; it now reads the Basket's, and the sweeper garbage-collects Holds by their Basket's expiry. The atomicity argument is unchanged: still one statement, still no JavaScript turn inside it.

**Reviving an expired Basket is a re-reservation, not a flag flip.** Its Holds are gone with its clock, so staff reviving it re-run the reservation per line under a fresh clock, and lines that no longer fit are dropped.
