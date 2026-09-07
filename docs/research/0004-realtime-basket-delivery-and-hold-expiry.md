# Research: realtime basket delivery and hold expiry

Resolves [#4](https://github.com/KeeprDigital/shop-keepr/issues/4). Parent map: [#1](https://github.com/KeeprDigital/shop-keepr/issues/1).
Date: 2026-09-07. All claims cited to primary sources; verbatim quotes marked.

> **Note on file location.** The repo had no existing convention for research notes
> (`docs/agents/` holds skill guidance; `docs/adr/` does not exist yet). Placed at
> `docs/research/NNNN-<slug>.md`, numbered by issue. If a `docs/adr/` convention lands
> later, this should graduate into an ADR.

---

## Recommendation

**One Durable Object per store. WebSocket hibernation for push. A single DO alarm as the
expiry sweeper — but lazy expiry on read is the correctness invariant, not the alarm.**

Concretely:

| Requirement | Mechanism |
| --- | --- |
| Push Basket to staff | Hibernatable WebSockets on a per-store DO (`store:<storeId>`), fan-out via crossws pub/sub |
| Hold expiry | `expiresAt` timestamp is authoritative; every read filters `expiresAt > now`. One DO alarm set to the earliest `expiresAt` fires the release *event* (broadcast + row GC) |
| Hold state lives | **Inside the DO's SQLite storage**, not the primary store. The primary store owns Movements and Inventory Items; the DO owns reservations |

Rejected: Ably (solves only transport, leaves expiry needing a DO or cron anyway, adds a
vendor and a token-minting endpoint). Rejected as the *only* mechanism: polling (it is
genuinely sufficient for correctness, and costs more requests than hibernated WebSockets at
this scale — see [§7](#7-the-honest-lower-bound-polling--lazy-expiry)).

### Why "lazy expiry AND an alarm" rather than one or the other

Cloudflare publishes **no delivery-latency guarantee** for alarms — only at-least-once
execution with exponential-backoff retry ([§1](#1-do-alarms)). So an alarm must never be the
thing that *makes* a Hold expired; otherwise a late alarm sells a card twice. Making
`expiresAt` authoritative and computing available-to-promise as
`on-hand − Σ(holds where expiresAt > now)` means:

- correctness does not depend on the alarm firing on time, or at all;
- the alarm's only job is liveness — telling staff screens "that Hold just lapsed" and
  deleting dead rows;
- the design degrades to plain polling if the socket drops, with no correctness change.

This is the cheap-to-extend answer the map asks for: the expiry *rule* is a pure function of
`(now, holds)` that is testable without any Cloudflare runtime at all.

---

## Where Hold state lives, per data-layer option (#2 unresolved)

Issue [#2](https://github.com/KeeprDigital/shop-keepr/issues/2) is deciding D1 vs Postgres/Hyperdrive vs DO SQLite for the
primary store. **This recommendation does not depend on that outcome**, because a Hold is not
primary-store data: it is short-lived, TTL-scoped, never audited, and must be serialised
against concurrent kiosks. Movements are the opposite on every axis.

| #2 outcome | Where Holds live | What changes |
| --- | --- | --- |
| **D1** | DO SQLite (recommended shape) | Strongest case for the DO. D1 has **no interactive transactions** — `BEGIN TRANSACTION` errors, and `.batch()` cannot interleave JS between statements ([§8](#8-d1-and-serialisation)). Since available-to-promise is a ledger sum minus holds, a safe "reserve the last copy" is a read-modify-write that D1 cannot do atomically. The DO's global-uniqueness guarantee supplies exactly that serialisation point. |
| **Postgres via Hyperdrive** | DO SQLite still, or Postgres | Postgres *can* do the read-modify-write in one transaction (`SELECT … FOR UPDATE`), so Holds-in-Postgres becomes viable. Keep them in the DO anyway unless the team wants one fewer moving part: Holds in Postgres means the alarm still lives in a DO (or a cron), and a Hold write becomes a Hyperdrive round-trip on every kiosk tap. Caution: an outbound connection from a DO **prevents hibernation and incurs duration charges for up to 15 minutes per connection** ([§2](#2-websocket-hibernation-cost-model)) — so do not hold a Postgres connection open inside the socket DO. |
| **DO SQLite as primary store** | Same DO, separate tables | Holds and Movements land in the same SQLite database. Simplest of the three; the whole store is one DO. Watch the 10 GB per-object storage ceiling ([§3](#3-partitioning-per-store-vs-per-sku)) and note that a single DO caps at a **soft 1,000 req/s** — irrelevant at one store. |

In every case: on Basket confirmation, the DO writes the sale-out **Movement** to the primary
store and then deletes the Hold. That write is the transactional boundary; the Hold is not.

---

## Evidence

### 1. DO alarms

Source: [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) (docs updated 2026-04-21),
[Alarms announcement](https://blog.cloudflare.com/durable-objects-alarms/).

- **One alarm per object.** "Each Durable Object is able to schedule a single alarm at a time
  by calling `setAlarm()`." `setAlarm()` on an existing alarm "will override the existing
  alarm." → Many Holds must be multiplexed onto one alarm.
- **Cloudflare documents the exact multiplexing pattern** we need: store the schedule in
  storage, have `alarm()` process due events and reschedule itself for the next one
  ("Scheduling multiple events with a single alarm"). Our Hold table *is* that schedule.
- **Reliability.** "Alarms have guaranteed at-least-once execution and are retried
  automatically when the `alarm()` handler throws." "Retries are performed using exponential
  backoff starting at a 2 second delay from the first failure with up to 6 retries allowed."
- **Retries are finite.** Docs warn: "Because alarms are only retried up to 6 times on error,
  it's recommended to catch any exceptions inside your `alarm()` handler and schedule a new
  alarm before returning." → Our handler must `try/catch` and always reschedule.
- **Granularity.** Scheduling is millisecond-precision (`setAlarm(scheduledTimeMs)`), but
  there is **no published upper bound on firing latency**. The announcement post only says
  "Single failures should resolve in under 30 seconds, while multiple failures may take
  slightly longer" — that is about *retry* latency, not steady-state delivery. Treat alarm
  timing as best-effort; hence lazy expiry.
- **Alarms are durable.** "Alarms are modified using the Storage API, and alarm operations
  follow the same rules as other storage operations." Storage survives eviction and restart
  ([§4](#4-what-survives-a-do-restart-or-migration)). A set alarm therefore survives hibernation, eviction and code
  deploys.
- **An alarm wakes a hibernated object.** "the first incoming request or event (like an alarm)
  will execute the `constructor()`" ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
- **`deleteAlarm()` is best-effort** ("Unsets the alarm … on a best-effort basis"; inside
  `alarm()` it "may prevent retries on a best-effort basis, but is not guaranteed") → the
  handler must be idempotent.
- **Cost.** An alarm invocation is billed as one request; "Each `setAlarm()` is billed as a
  single row written" ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **Alarm handler wall time: 15 minutes max** ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- **Local-dev gotcha.** "when developing locally (using `npx wrangler dev`), Durable Object
  alarm methods may fail after a hot reload … close and restart your `wrangler dev` command
  after editing your code" ([known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)).
  Worth putting in the repo README before someone loses an afternoon.

**Why not Workers Cron Triggers instead?** Minimum granularity is one minute (cron minute
field, "At every minute"), the account is capped at 5 (Free) / 250 (Paid) triggers
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)), and trigger changes
"may take several minutes (up to 15 minutes) to propagate"
([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
Cloudflare's own framing: "Alarms are more fine grained than Cron Triggers … it can have an
unlimited amount of Durable Objects, each of which can have an alarm set." A one-minute
sweeper is *acceptable* for a TTL measured in minutes, but it is a worse fit and it still
needs somewhere to push from.

### 2. WebSocket hibernation cost model

Sources: [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) (2026-06-19),
[Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) (2026-07-03),
[Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (2026-08-25).

- **The mechanism.** `ctx.acceptWebSocket(server)` instead of `ws.accept()`. "Unlike
  `ws.accept()`, `state.acceptWebSocket(ws)` allows the Durable Object to be hibernated."
  While hibernated: "WebSocket clients remain connected to the Cloudflare network", "In-memory
  state is reset", and "When an event arrives, the Durable Object is re-initialized and its
  `constructor` runs."
- **The billing claim.** "Billable Duration (GB-s) charges do not accrue during hibernation."
  And, more precisely: "Durable Objects that are idle and eligible for hibernation are not
  billed for duration, **even before the runtime has hibernated them**."
- **The trap.** "Calling `accept()` on a WebSocket in an Object will incur duration charges
  for the entire time the WebSocket is connected." Using the non-hibernation API on a socket
  open all trading day is the difference between ~$0 and Cloudflare's own worked Example 3
  (**$419.30/month** for 100 always-active objects). Hibernation is not an optimisation here;
  it is the whole cost model.
- **Hibernation preconditions (all must hold).** No `setTimeout`/`setInterval`; no in-progress
  awaited `fetch()`; no standard-API WebSocket; no request/event still being processed; no
  active outbound TCP socket or outbound WebSocket. Then: "After 10 seconds of no incoming
  request or event … the Durable Object will transition into the hibernated state."
  → **Do not use `setInterval` for expiry** (it also cannot survive hibernation: "there would
  be no way to recreate the callback after hibernating"), and **do not hold an outbound
  Postgres/TCP connection open** in this DO.
- **Outbound connections are expensive.** "An active outbound connection … keeps a Durable
  Object in memory and causes it to incur duration charges for up to 15 minutes per
  connection, even with no incoming requests."
- **SSE is the worse cousin.** A held-open SSE response is "a request/event still being
  processed", so the object stays in the *idle, in-memory, non-hibernateable* state and
  "continues to incur duration charges". SSE is simpler to write and strictly more expensive
  to run. Prefer WebSocket + hibernation.
- **Request billing.** "Includes HTTP requests, RPC sessions, WebSocket messages, and alarm
  invocations." Incoming WebSocket messages get a **20:1 discount ratio** ("100 WebSocket
  incoming messages would be charged as 5 requests"); "There is no charge for outgoing
  WebSocket messages, nor for incoming WebSocket protocol pings." Auto-responses via
  `state.setWebSocketAutoResponse()` "will not incur additional wall-clock time, and so they
  will not be charged" — use it for client heartbeats.
- **Included allowances (Workers Paid).** 1M requests/month then $0.15/M; 400,000 GB-s/month
  then $12.50/M GB-s; duration bills 128 MB regardless of actual use.

**Projected cost at shop-keepr's scale.** 2 kiosks + 2 staff screens = 4 concurrent sockets on
one DO. Assume 12 trading hours, ~2,000 inbound messages/day, ~30 (re)connections/day, ~200
Hold expiries/day:

- Requests/month ≈ 60,000 messages ÷ 20 + 900 connections + 6,000 alarm invocations
  ≈ **~10k billable requests** — 1% of the included 1M.
- Duration: the object is only in memory while executing handlers. Even at a generous
  10 ms/message and 100 ms/alarm, that is under 2,000 s/month ≈ **256 GB-s** — 0.06% of the
  included 400,000 GB-s.

Marginal cost is effectively **zero above the Workers Paid $5/month minimum**. The cost
argument against Durable Objects does not exist at this scale.

### 3. Partitioning: per-store vs per-SKU

**Per store. Not per SKU.** Evidence:

- **Scale headroom is enormous.** "Request throughput: soft limit of 1,000 requests per second
  per Object" and per-object storage of 10 GB
  ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). One store with
  four screens is four orders of magnitude below that. There is no throughput reason to shard.
- **A Basket spans SKUs.** Adding three cards to a Basket must reserve three Inventory Items.
  With per-SKU DOs that is a three-way distributed transaction with no rollback primitive —
  Cloudflare gives you atomicity *within* an object, not across objects. Per-store makes it one
  local SQLite transaction.
- **One alarm, not N.** Per-SKU means one alarm per SKU (fine — "unlimited amount of Durable
  Objects, each of which can have an alarm set") but also N objects to wake, N `setAlarm()`
  row-writes, and no single place that knows the queue. Per-store multiplexes every Hold onto
  one alarm using Cloudflare's documented pattern.
- **Fan-out wants one object.** Only a Durable Object's own context "owns its (hibernatable)
  sockets via `ctx.getWebSockets()` and can fan a message out to them"
  ([crossws Cloudflare adapter](https://crossws.h3.dev/adapters/cloudflare)). With a single
  instance "every connection across your app already lands on that same Durable Object, so
  `peer.publish()` is cluster-global out of the box. **No backplane needed.**" Sharding would
  force a sync backplane, and crossws documents that relayed inbound delivery is then
  best-effort: "A message relayed *into* a hibernated Durable Object may miss some sockets."
  Per-store sidesteps this entirely.
- **Multi-store later is free.** The map mandates `storeId` on every table. `getByName(\`store:${storeId}\`)`
  scales to N stores by construction — the partition key is already the tenancy key. This is
  the cheap-to-extend property the map asks for.
- **Placement.** "By default, a Durable Object is instantiated in a data center close to where
  the initial `get()` request is made" and "Durable Objects do not currently change locations
  after they are created"
  ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
  A single-store app has all its traffic in one city → pass an explicit `locationHint` on
  creation, or make sure the first-ever request comes from the shop, not from a CI job in
  us-east. Hints are "best effort and not a guarantee." Jurisdiction (`eu`/`us`) is the harder
  constraint if data residency ever matters.

### 4. What survives a DO restart or migration

Source: [Lifecycle → Shutdown behavior](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
[Known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/),
[Access DO Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
[Migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

| Thing | Survives hibernation | Survives eviction / restart / deploy |
| --- | --- | --- |
| SQLite / KV storage (Holds) | Yes | **Yes** |
| Alarm | Yes | **Yes** (it is storage) |
| In-memory instance fields | **No** | No |
| WebSocket connections | **Yes** | **No** — terminated |

- Objects restart routinely: "New Worker deployments with code updates", inactivity, "Cloudflare
  updates to the Workers runtime system", "Workers runtime decisions on where to host objects".
- "When hibernated, the in-memory state is discarded, so ensure you persist all important
  information in the Durable Object's storage." → **Holds must be written to storage on the
  request that creates them**, never cached in a field. The docs are explicit that there are no
  shutdown hooks: "Shutdown hooks or lifecycle callbacks that run before shutdown are not
  provided."
- **Sockets die on deploy.** "WebSocket requests are terminated automatically during shutdown.
  This is so that the new instance can take over the connection as soon as possible."
  → the kiosk and staff clients **must** auto-reconnect with backoff and re-fetch a full
  snapshot on open. At 4 clients, send the whole queue on connect; do not build delta replay.
- **Version skew is real.** "a request arrives to the latest version of your Worker … which
  then calls to a unique Durable Object running the previous version of your code for a short
  period of time (typically seconds to minutes) … it is best practice to ensure that API
  changes between your Workers and Durable Objects are forward and backward compatible."
  → version the DO's message envelope from day one.
- **Storage-access errors are the uniqueness enforcement.** "Uniqueness is enforced upon
  starting a new event … and upon accessing storage." If an object is superseded mid-event, a
  storage access "will receive an exception". Callers must tolerate a retryable failure on a
  hold-create; the stub itself may be left "in a broken state … create a new one for any
  subsequent requests" ([error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)).
- **Migrations are the dangerous part.** Deleting a class "removes its namespace and **all of
  its stored data permanently**"; "There is no Trash for Durable Object namespaces deleted
  through `exports`." Also "Storage type is immutable once a namespace exists." If Holds are
  the only thing in the DO, a botched migration costs at most one TTL window of reservations —
  a real argument for *not* putting Movements in the same DO unless #2 chooses DO SQLite
  deliberately.
- **PITR as a safety net.** SQLite-backed DOs "offer Point In Time Recovery API which can
  restore a Durable Object's embedded SQLite database contents … to any point in the past 30
  days." KV-backed ones do not.

### 5. Nitro / Nuxt integration (this is the decisive practical finding)

**Nuxt 4.5.2 ships Nitro v2** (`nuxt@4.5.2 → @nuxt/nitro-server@4.5.2 → nitropack@^2.13.4`,
verified against the npm registry). Nitro v2 has a first-class **`cloudflare-durable`** preset.
Read from source
([`src/presets/cloudflare/runtime/cloudflare-durable.ts`, branch `v2`](https://github.com/nitrojs/nitro/blob/v2/src/presets/cloudflare/runtime/cloudflare-durable.ts)):

- The preset exports `class $DurableObject extends DurableObject` and resolves it as
  `binding.idFromName("server")` — i.e. **a single, app-wide DO instance named `server`**.
- WebSocket upgrades are routed to that DO via `crossws/adapters/cloudflare-durable`, which
  uses the hibernation API (`handleDurableUpgrade` / `webSocketMessage` / `webSocketClose`).
- **Ordinary HTTP requests do not go through the DO.** The preset's `fetch` hook returns
  `undefined` for non-upgrade requests, and `createHandler` then falls through to the normal
  Worker `fetchHandler` (verified in `_module-handler.ts`). A `ctxExt.durableFetch()` escape
  hatch is exposed if a route wants to forward into the DO deliberately. This corrects the
  wording on the current Nitro docs site, which describes the preset as routing *requests*
  through a DO.
- Two Nitro hooks are wired for us: **`cloudflare:durable:init`** (called from the DO
  constructor) and **`cloudflare:durable:alarm`** (the DO's `alarm()` handler calls
  `nitroApp.hooks.callHook("cloudflare:durable:alarm", this)`). The Hold sweeper is a Nitro
  server plugin listening on that hook — no bespoke DO class required.
- The DO also exposes `publish(topic, data, opts)` for pub/sub fan-out.

**Two gotchas to carry into the build ticket:**

1. **Nitro does not write the DO binding or migration into your wrangler config** (no
   `durable_objects` handling in `src/presets/cloudflare/utils.ts`). You must add it yourself.
2. **Both the Nitro and crossws docs show `new_classes` — use `new_sqlite_classes`.** Cloudflare
   now states: "Creating new namespaces with the key-value storage backend is no longer
   supported for accounts without an existing key-value-backed namespace", and "Storage type is
   immutable once a namespace exists." Copying the doc snippet verbatim would either fail or
   permanently lock you out of SQL storage and PITR.

```jsonc
// wrangler.jsonc — required, not generated
{
  "durable_objects": {
    "bindings": [{ "name": "$DurableObject", "class_name": "$DurableObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["$DurableObject"] }]
}
```

The repo today has **no wrangler config and no `nitro.preset` in `nuxt.config.ts`** — this is
greenfield, so there is nothing to migrate.

**Caveat on the single instance.** The preset hardcodes instance `"server"`, which is one DO for
the whole deployment, not one per store. At one store that is the same object. For multi-store
later, override `resolveDurableStub` (crossws adapter option) to key on `storeId`, and accept
that pub/sub then needs a sync backplane.

### 6. Ably

Source: [Ably pricing](https://ably.com/pricing).

- Free: "6M messages / month", "200 concurrent connections", 200 concurrent channels,
  "500 / second" message rate. Our load fits inside the free tier several times over.
- First paid tier: "$29 / month" (Standard). Overages: "$2.50 / million" messages,
  "$1.00 / million mins" connection minutes, "$0.25 / GiB" transfer.

**Verdict: reject.** Not on price — on scope.

- It solves exactly one of the two coupled requirements. Ably has no server-side timer
  primitive, so Hold expiry still needs a DO alarm, a Workers cron, or lazy-only expiry. You
  end up owning the harder half anyway.
- It adds a second identity/authorisation surface (token requests signed by a Worker), a second
  status page, and a second SDK in a Nuxt app that already gets WebSockets from its own preset
  for free ([§5](#5-nitro--nuxt-integration-this-is-the-decisive-practical-finding)).
- It gives no serialisation point for concurrent Holds on the same SKU — the thing that
  actually makes this problem non-trivial ([§8](#8-d1-and-serialisation)).

Keep it as the documented fallback the map already names, in case DO WebSocket behaviour on the
shop's network proves troublesome. It is a transport swap, not an architecture change, provided
Hold state stays in the DO.

### 7. The honest lower bound: polling + lazy expiry

**It would work.** Lazy expiry is correct by construction and needs no timer at all. Polling
every 3 s from four screens is not a load problem. The ticket asks whether this is enough — and
on correctness, it is.

Three things argue against shipping polling *alone*:

1. **It costs more, not less.** 4 clients × 1 request/3 s × 12 h/day ≈ 57,600 requests/day ≈
   **1.7M Worker requests/month**, each doing a ledger-sum query against the primary store. The
   hibernated-WebSocket design costs ~10k billable DO requests/month
   ([§2](#2-websocket-hibernation-cost-model)). The intuition that polling is the cheap option
   is inverted here by the 20:1 WebSocket ratio and hibernation.
2. **It does not solve the concurrency problem.** Two kiosks reaching for the last NM copy of a
   card is the one genuinely hard case in this domain, and polling does nothing for it. On D1
   you cannot fix it with a transaction either ([§8](#8-d1-and-serialisation)). You need a
   serialisation point regardless — and once you have a DO for that, the socket and the alarm
   are ~40 lines on top.
3. **The retrofit is not free.** Adding push later means adding a DO, moving Hold writes into
   it, adding reconnect logic to two client surfaces, and re-testing the whole hold path — i.e.
   most of the work, done twice, against a shipped system.

**But adopt the lazy-expiry half unconditionally**, exactly as recommended above. And keep a
polling fallback in the client: if the socket is closed, poll every 5 s. That fallback costs a
few lines, makes the deploy-kills-sockets behaviour ([§4](#4-what-survives-a-do-restart-or-migration))
invisible to staff, and is the thing that lets you honestly say the realtime layer is
non-load-bearing.

### 8. D1 and serialisation

Source: [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[D1: our quest to simplify databases](https://blog.cloudflare.com/whats-new-with-d1/).

- "Batched statements are SQL transactions. If a statement in the sequence fails, then an error
  is returned for that specific statement, and it aborts or rolls back the entire sequence."
- But: "if you try running `BEGIN TRANSACTION` in D1 you'll get an error", because "if we
  permitted `BEGIN TRANSACTION`, any one Worker request, anywhere in the world, could
  effectively block your whole database!" Interactive transactions — interleaving JS between
  statements inside one transaction — are not supported.

Available-to-promise is `on-hand (a SUM over the Movement ledger) − active Holds`. Reserving
requires reading that, deciding, then writing — a read-modify-write with JS in the middle. On
D1 that is not atomic. The DO's global uniqueness ("there is only a single instance of a
Durable Object class with a given ID running at once, across the world") is the cheapest
available fix, and it is one we need anyway for the socket and the alarm.

---

## Design sketch

One DO per store. SQLite-backed. Single alarm.

```
holds(id, basket_id, inventory_item_id, qty, price_snapshot, created_at, expires_at)
baskets(id, number, customer_name, status, created_at)
```

- **Add to basket** → RPC into DO → in one SQLite transaction: recompute ATP (see below),
  insert Hold, insert/update Basket line → `setAlarm(min(expires_at))` if earlier than current
  → `publish("store:<id>:queue", snapshot)`.
- **ATP source** depends on #2. If the ledger is in D1/Postgres, the DO caches on-hand per SKU
  and refreshes it on write; the DO remains authoritative for *holds*, which is what needs
  serialising. If the ledger is in the same DO, it is a local `SUM`.
- **`alarm()`** (via the `cloudflare:durable:alarm` Nitro hook) → `DELETE FROM holds WHERE
  expires_at <= now` → broadcast → `setAlarm(next min(expires_at))`, all inside `try/catch`
  that reschedules on failure.
- **Every read** filters `expires_at > now`. The alarm is never trusted for correctness.
- **Clients** subscribe on connect, receive a full snapshot, and fall back to 5 s polling
  whenever the socket is not open.
- **Confirm basket** → write Movements to the primary store → delete Holds → broadcast.

## Open questions for the build ticket

1. TTL default and configurability — where does the store setting live (primary store, or DO
   config row)? A TTL change must not retroactively alter existing `expires_at`.
2. Does a staff member extending or manually releasing a Hold need to be a Movement-adjacent
   audit event, or is it invisible? (Map says Holds are soft; assuming invisible.)
3. Does the kiosk need a live "someone else just took the last one" signal, or is a stale
   basket line rejected at confirm time? The DO makes either possible; the second is simpler.
4. Location hint / jurisdiction for the DO — depends on where the store is. Needs one line of
   config and cannot be changed after creation.

## Sources

- Cloudflare, [Durable Objects — Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- Cloudflare, [Durable Objects — Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Cloudflare, [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- Cloudflare, [Durable Objects — Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- Cloudflare, [Durable Objects — Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Cloudflare, [Durable Objects — Known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)
- Cloudflare, [Access Durable Objects Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- Cloudflare, [Durable Object class exports / migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- Cloudflare, [Durable Objects — Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- Cloudflare, [Durable Objects — Error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
- Cloudflare, [Workers — Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and [Workers — Limits](https://developers.cloudflare.com/workers/platform/limits/)
- Cloudflare, [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- Cloudflare Blog, [Durable Objects Alarms](https://blog.cloudflare.com/durable-objects-alarms/)
- Cloudflare Blog, [D1: our quest to simplify databases](https://blog.cloudflare.com/whats-new-with-d1/)
- Nitro, [`src/presets/cloudflare/runtime/cloudflare-durable.ts` (v2)](https://github.com/nitrojs/nitro/blob/v2/src/presets/cloudflare/runtime/cloudflare-durable.ts) and [`_module-handler.ts` (v2)](https://github.com/nitrojs/nitro/blob/v2/src/presets/cloudflare/runtime/_module-handler.ts)
- Nitro, [Cloudflare deployment provider](https://nitro.build/deploy/providers/cloudflare)
- CrossWS, [Cloudflare adapter](https://crossws.h3.dev/adapters/cloudflare)
- Ably, [Pricing](https://ably.com/pricing)
- npm registry: `nuxt@4.5.2`, `@nuxt/nitro-server@4.5.2` (Nitro v2 confirmation)
