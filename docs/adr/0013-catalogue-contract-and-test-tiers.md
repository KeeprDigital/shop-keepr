---
status: accepted
---

# The Catalogue is reached over HTTPS as a named consumer; staging's OpenAPI document is the contract; the fixture is the every-commit tier

Every call across the Catalogue seam — seed, delta, Market Price walk, live resolution of an undescribed card — goes over HTTPS with a per-environment credential that identifies shop-keepr as Consumer #1; a Cloudflare service binding is not used. The contract is the Catalogue's generated OpenAPI document as served by **staging**, fetched and committed here, from which one pinned generator emits TypeScript types and Zod 4 schemas; every pulled record is validated against them at ingest. Tests run against a committed fixture on every commit, against Catalogue staging as the merge gate, and never against production. Decided in [#9](https://github.com/KeeprDigital/shop-keepr/issues/9) and [#23](https://github.com/KeeprDigital/shop-keepr/issues/23).

The surprise this records: **both systems are ours, both are Workers in one account, and the obvious optimisations were rejected.** A service binding costs deployment independence and cross-environment uniformity: two transports means two code paths tested twice across four environments. A shared bearer secret has no identity, no scopes and total blast radius. Pointing CI at a local card-keepr tests nothing, because a local instance serves an empty catalogue.

## Considered options

**Service binding** — rejected as above; also assumes a same-account guarantee that was unverified.

**Cloudflare Access service tokens** — rejected: consumers must live in our Zero Trust org, no scopes, no metering.

**A published client package from the Catalogue** — rejected: couples release cadence across repos.

**Hand-written schemas** — rejected: silent drift.

**Dev as a test target** — rejected: dev is the owning team's inner loop and exists to be broken; a consumer's red build against it says nothing.

## Consequences

**The sync module takes `{ fetch, baseURL, credential }`** and has one code path; tests pass a `fetch` that serves the committed fixture by path. Nuxt's `registerEndpoint` does not intercept absolute URLs and must not be worked around with a second code path.

**Contract change is a reviewable diff**: `pnpm catalogue:contract` regenerates document and output; CI asserts freshness. Staging-to-production drift is the Catalogue's promotion concern.

**The fixture is load-bearing, not a stand-in.** It must hold more than one Game System, several Printings of one Card, a withdrawn entity, two Cards sharing a name, non-Latin and long names, one game's full Facet range, and a Printing with and without a Market Price. It does not test scale.

**Per-consumer identity is built before a second consumer exists**, because it is expensive to retrofit. The card-keepr side is filed as card-keepr#269.
