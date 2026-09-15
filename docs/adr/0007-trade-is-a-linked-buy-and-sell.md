---
status: accepted
---

# A Trade is a linked Buy and Sell, not a third ledger kind

When a customer hands cards over and takes cards away in one act, shop-keepr records one Transaction as a Buy entry and a Sell entry in one atomic write, both carrying the same `trade_id`, the same POS Reference and the same `net`, and each its own `total`. The ledger keeps exactly three kinds: Buy, Sell and Adjustment. Decided in [#11](https://github.com/KeeprDigital/shop-keepr/issues/11).

## Considered options

**A `trade` kind holding both directions.** One header with every detail of the trade. Rejected: its lines need a direction and a price pair each (buy list/transacted or sell list/transacted); every query that means "sales" or "purchases" must read `sell` or `buy` rows _plus_ `trade` rows filtered by direction, forever; the on-hand projection handles signed lines per kind; and [ADR 0001](./0001-append-only-ledger.md)'s reversal rule gains the same direction filter. A fourth kind is a permanent tax on every stock and money query for the sake of one row where two will do.

**Two Transactions sharing a POS Reference, nothing more.** Already permitted, since a POS Reference is not unique. Rejected as too loose: "show me that trade" has no query, and the net cannot be placed anywhere.

## Consequences

**`trade_id` is a nullable column on the entry header.** Null for an ordinary Buy or Sell; the same value on both halves of a Trade. A Trade is one query on it.

**Both halves carry the same `net`**, the money that moved at the till, which for a Trade is the difference between the two sides. It is a snapshot with the standing of a transacted price: immutable, the audit number beside the POS Reference, never used to derive anything. A partial reversal of one half is its own entry with its own net and does not touch the original.

**Each half also carries its own `total`**, what its cards were worth as settled ([ADR 0010](./0010-tender-and-total-factors-on-the-total.md)); amended by [#44](https://github.com/KeeprDigital/shop-keepr/issues/44). Without it a Trade Buy's only money figure would be the difference, and what the store paid for the pile would be recoverable only by re-running the header's factors over the lines. `net` is stored rather than derived from the two totals because it is the receipt figure, written at the time; settings move and rounding drifts.

**Which entries a Transaction commits as is decided by its contents.** The Transaction being built at the counter has a sell side and a buy side; lines on one side make a Sell or a Buy, lines on both make a Trade. There is no "start a Trade" mode, and the Buy and Sell services are the only write paths, invoked together for a Trade.

**Amended by [#46](https://github.com/KeeprDigital/shop-keepr/issues/46).** _Transaction_ now names the act at the till — one customer, one POS Reference, one `net` — recorded as one or two ledger entries (Buy, Sell); a Trade is one Transaction with two entries. The wording above was "not a third Transaction kind"; the structure is unchanged, only what the word points at.
