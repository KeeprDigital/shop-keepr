---
status: accepted
---

# A Hold is reserved by one conditional insert in D1; no Durable Object

A Hold is a row in the same D1 database as stock, reserved by a single `INSERT … SELECT … WHERE available ≥ quantity` whose availability check runs inside the statement, so D1's single-threaded execution is the serialisation point. Transport to the staff queue is polling by cursor behind one subscription interface; expiry is lazy on read (`basket.expires_at > now` in the availability query) with a one-minute Cron Trigger that only garbage-collects Hold rows. The Durable Object the planning map had favoured is not adopted for the MVP. Decided in [#4](https://github.com/KeeprDigital/shop-keepr/issues/4), re-verified on real D1 in [#17](https://github.com/KeeprDigital/shop-keepr/issues/17).

The surprise this records: **the premise that reserving the last copy needs an interactive transaction was disproved by measurement.** 16,250 reservation attempts at concurrency up to 200, locally and from a deployed Worker, oversold zero times; a JavaScript read-then-write negative control oversold in every run. That removes the Durable Object's only architectural justification, and `docs/research/0004-realtime-basket-delivery-and-hold-expiry.md`, written before the spike, still recommends the opposite.

## Considered options

**Durable Object holding the reservation and the clock** — rejected for the MVP as above; remains the likely successor for push transport, via Nitro's `cloudflare-durable` preset, if more than a handful of concurrent screens, sub-second latency, multi-store, or a live-reacting kiosk ever arrives.

**Plain SSE** — eliminated, not deferred: Workers are isolate-local, so SSE needs a DO or Ably behind it regardless.

**Ably** — the documented fallback; viable if reconnect, history and presence ergonomics outweigh avoiding a vendor.

**Turso interactive transactions** — 960 `SQLITE_BUSY` errors at 25 racers ([#18](https://github.com/KeeprDigital/shop-keepr/issues/18)).

## Consequences

**Correctness never depends on a timer firing.** The `expires_at` predicate on read is the invariant; the cron is hygiene.

**`changes = 0` is ambiguous** between "just gone" and "unknown SKU"; the kiosk re-reads availability to choose its message.

**Every dependent statement on the Hold path carries its own SQL condition** (`AND EXISTS …`), because `batch()` is atomic but not conditional (ADR 0011). A timed-out reserve may have committed, so `UNIQUE(basket_id, sku_id)` is the recommended idempotency key.

**The subscription interface is the upgrade seam.** Nothing calls `setInterval`; the poller synthesises `basket created / changed / fulfilled / expired` events by cursor, and a push implementation emits the same events from the same cursor with nothing downstream changing.
