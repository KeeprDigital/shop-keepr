---
status: accepted
---

# The Catalogue asserts observations; shop-keepr asserts policy

Both `card-keepr` (the Catalogue) and shop-keepr are ours, so the line between them is drawn rather than given. It falls here: **the Catalogue asserts observations about a Printing — facts about the world that are true regardless of who is asking — and shop-keepr asserts policy — what this store chooses to do about them.** Decided in [#23](https://github.com/KeeprDigital/shop-keepr/issues/23).

The surprise this records is that the line is _not_ "whatever shop-keepr needs, the Catalogue supplies". Both repos are ours and the Catalogue changes on our word, so the cheap move is to push every requirement across the boundary. This ADR exists to say that the boundary survives common ownership.

## Why this rule and not "put it wherever is convenient"

The rule was not invented to settle the two cases that prompted it. It was tested against decisions it played no part in, and it reproduces them:

- **[ADR 0003](0003-stepped-exchange-rate.md) put currency conversion in shop-keepr.** The rule independently agrees: an exchange rate is an observation about _the world_, not about a **Printing**, so it fails the test for Catalogue-side. The ADR reached that by a different route entirely — change-detection blast radius and retail stability.
- **[#22](https://github.com/KeeprDigital/shop-keepr/issues/22) made the kiosk's Game System picker a store setting** rather than a mirror of Catalogue coverage. Policy, correctly shop-keepr-side.
- **[#21](https://github.com/KeeprDigital/shop-keepr/issues/21) kept Condition and Language out of the Catalogue** while putting Market Price in it. Under this rule that stops being two separate judgements and becomes one: where your NM bar sits is your policy; what a Printing trades for is an observation.

A rule that reproduces three prior decisions it was not derived from is describing something real, rather than rationalising the cases in front of it.

## What it decides

**Catalogue-side, because they are observations about a Printing:** Market Price, rarity and the other per-game Pricing Attributes, printed text, images, set and variation, lifecycle and withdrawal.

**shop-keepr-side, because they are this store's policy:** Condition and Language multipliers, pricing rules, floors, margins, rounding, which Game Systems the kiosk shows, what the store stocks, and the prices it actually charges.

## Consequences

**It decides future cases without reopening the argument.** That is most of its value. Each new field is one question — is this true regardless of who is asking? — rather than a fresh negotiation.

**It says which side an observation belongs on, not whether the Catalogue should carry it at all.** Scope stays a separate judgement. Read as "the Catalogue must observe everything observable" it becomes a mandate for unbounded growth, which is not what it means.

**It hardens as the Catalogue becomes a product.** The Catalogue is expected to acquire other consumers and may be sold access. At that point store-agnosticism stops being a preference we could trade away and becomes a constraint the product rests on — and this rule is already the shape of it. Until then it is a discipline we keep on purpose.

**The awkward cases are derived observations.** Normalised rarity is an interpretation, and interpretation resembles policy. It sits Catalogue-side because it is an assertion about the Printing that holds for every consumer, not about what any store does with it. Expect the boundary to be argued here rather than at the obvious fields.
