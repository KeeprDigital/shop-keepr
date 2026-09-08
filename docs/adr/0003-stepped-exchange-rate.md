---
status: accepted
---

# Currency conversion happens in shop-keepr, on a stepped exchange rate

The Catalogue supplies Market Price in its own currency, and shop-keepr converts it into the currency the store trades in. The exchange rate is fetched on a schedule but held as a **discrete, versioned value**: it is applied only when it has moved past a threshold, it can be set by hand, and between steps it does not move at all. Decided in [#21](https://github.com/KeeprDigital/shop-keepr/issues/21).

The surprise this records is deliberate: **the shop prices off an exchange rate that is knowingly a little out of date.** Anyone reading the sync code will find a live rate available and a stored one used instead, and should not "fix" it.

## Considered options

**Convert at the source, so every consumer gets one number.** Superficially the tidier boundary — one implementation, no consumer reinventing it. Rejected on a consequence that is easy to miss: a converted price moves whenever the exchange rate moves, so the Catalogue's change detection would either fire for every Printing on every tick — collapsing shop-keepr's changed-only recompute into a daily sweep of everything — or not fire at all, leaving stored prices quietly wrong. It also pushes a fact about one consumer's trading currency into a service that is deliberately store-agnostic.

**A live rate, applied continuously, inside shop-keepr.** Rejected on four counts, none of which is cost. **Retail stability**: Sell Price is snapshotted onto a Basket when an item is added, which covers a basket in flight but not a customer who browses the kiosk, walks the shop and returns — a price that moved in between is a complaint at the counter. **Explicability**: with a stepped rate any price reconstructs as `market rate x condition multiplier x FX`; with a live rate the FX used at each recompute must itself be stored just to answer "why is this £4.20". **Dependency**: it is a second live integration, with a key, an outage mode and a rate limit, whose failure fallback is the last known rate — which is this decision, arrived at accidentally and unpredictably. **Precision**: sub-1% daily moves are under 3p on a £3 card, inside the rounding and far inside a buy/sell spread measured in tens of percent.

Note that "a live rate would force an expensive sweep" is *not* a reason. A sweep is bounded by the store's own SKU count, not the Catalogue's, and is cheap. That argument was raised while deciding this and does not hold.

**A purely manual rate.** Rejected as the version that rots: it works until nobody thinks about it for eight months. Automating the fetch while stepping the application keeps the stability and removes the neglect.

## Consequences

**An exchange-rate change is a deliberate, logged event.** Most fetches cross no threshold and recompute nothing. When one does, it triggers a full reprice — which is affordable, and which someone can point at when asked why a price changed.

**Price provenance depends on the rate version.** Reconstructing why a price was what it was needs the exchange rate in force at the time, not today's. Historical *transacted* prices are safe regardless: every Transaction snapshots the price it used.

**The threshold is a store setting, and sizing it is [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)'s call.** Too tight and the stability this buys evaporates; too loose and shelf prices drift away from the market. It is a number to tune, not a constant to hardcode.

**Revisit if the assumptions change.** This holds because the store trades in one currency, margins are wide, and daily moves are small. Multiple trading currencies, a volatile pair, or thin margins on high-value singles would each undermine it — though high-value cards are hand-priced anyway, which is the existing escape hatch.
