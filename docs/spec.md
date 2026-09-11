# shop-keepr MVP specification

The artefact the planning map ([Map: shop-keepr MVP](https://github.com/KeeprDigital/shop-keepr/issues/1)) was finding its way to. Every decision here was made in a closed map ticket or an ADR; this document assembles them so an implementation session never needs to reopen a ticket. Where it cites one, the ticket holds the reasoning and the rejected options; this document holds the decision.

**How to read it.** `CONTEXT.md` is the glossary and beats this document on vocabulary. `docs/adr/` holds the decisions that are hard to reverse; this document restates their consequences, never their arguments. `docs/catalogue-requirements.md` is the only Catalogue-facing input. A section that says _Open_ names something a later session decides during the build; a section that says _Deferred_ names something ruled past the MVP and not to be built.

**Standing rules for every build session.**

- The Catalogue's current implementation is never an input. Design against `docs/catalogue-requirements.md` and the committed OpenAPI document, not against card-keepr's code, routes or issues. Where the Catalogue lacks something, file the requirement there and build against a fixture here.
- Prefer decisions cheap to extend over decisions cheap to build. Follow-on work after the MVP is significant and expected.
- Vocabulary drift is a bug. A "cart", an "intake", a "credit balance" in code or UI copy is wrong by definition.
- One Nuxt 4 app, deployed to Cloudflare, serving the staff UI and the kiosk. No second service.

## 1. Scope

### 1.1 What shop-keepr is

A **single-store inventory manager for trading-card singles**, run alongside an external, proprietary point-of-sale (POS) system it does not integrate with. It answers _do we have this card, how many, at what price_, records every card moving in or out as a ledger entry, and prices stock from a Market Price the Catalogue supplies. Two surfaces, one app: an **internal staff UI** (desktop-first) and a **public in-store kiosk** (touch-first) from which a customer builds a Basket that staff fulfil at the till ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).

**Game Systems at the MVP:** Magic: The Gathering, Riftbound, One Piece, Pokémon. Which Game Systems a customer sees is a store setting. Adding a Game System is a rare, explicit, planned release allowed to cost real work; shop-keepr carries no code that assumes a particular game exists and does not gate on Catalogue coverage ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).

**Money.** shop-keepr never takes payment. The POS does; a POS Reference on every Buy and Sell is the only thread between cards moving here and money moving there. Store credit is a Tender, never a balance.

### 1.2 What the MVP delivers

| Area         | Delivered                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mirror       | The whole Catalogue mirrored into D1 per Game System, kept current by a cursor walk; every search runs locally (§4, §5)                             |
| Search       | Game-scoped, typo-tolerant, faceted search with an in-stock filter, shared by kiosk and staff (§4)                                                  |
| Stock        | SKU-grain inventory keyed `(store_id, printing_id, condition, language)`; append-only ledger; on-hand projection; available-to-promise on read (§3) |
| Transactions | Buy, Sell, Trade at the counter; Sell from the kiosk queue and from a Customer List; Buy from a Large Buy and from a Customer List (§3, §8)         |
| Adjustments  | Reasoned stock changes with no customer, including Ingest of the store's own stock (§3, §8)                                                         |
| Pricing      | Market Price from the Catalogue; Sell Price and Buy Price computed by a configurable pipeline and stored per SKU; Pinned Prices (§6)                |
| Kiosk        | Game gate → search → Printing → Basket → submit → Basket Number; Holds with a Basket-owned clock (§7)                                               |
| Staff UI     | Lookup · Transaction · Queue · Customer Lists · Large Buy · Ingest · Inventory · Pinned Prices · History · Settings · System (§8)                   |
| Auth         | One shared staff login; kiosk device identity (§7)                                                                                                  |
| Tenancy      | `store_id` on every table, hardcoded to one Store, no store UI                                                                                      |

### 1.3 Out of scope

Ruled beyond this MVP by the map. None of these is fog to be cleared; each returns only as a fresh effort if the destination is redrawn.

- **Sealed product and accessories.** Singles only. Booster boxes, packs, bundles, playmats and sleeves have no Printing, Condition or Game System attributes; they stay in the POS ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).
- **Bulk unsorted lots.** A shoebox bought at a flat per-card rate without identifying each card cannot exist under the SKU grain. Stays in the POS; cards sorted later enter through Large Buy or an Adjustment ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).
- **Store credit balances.** shop-keepr records only that a Buy was settled in credit; no customer entity, no credit ledger. The POS holds what a customer is owed ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).
- **POS integration.** The POS is an unknown proprietary system. Transactions carry an opaque POS Reference and a `surface`/`origin`; nothing more.
- **Offline or degraded operation.** No internet, no tool; staff fall back to the POS.
- **Reporting, analytics, valuation and margin views.** The ledger makes these cheap later.
- **Per-copy, serialised or graded inventory.** The SKU grain is quantity-based.
- **Public website or e-commerce.** No public web surface beyond the in-store kiosk.
- **Multi-store UI, store switching and scoped auth.** The `store_id` column exists; the product surface does not.
- **Seller identity capture on Buys.** Not applicable in this jurisdiction.
- **Kiosk payments.** The kiosk never takes money.
- **Buylist.** The term is defined so it is not misused; nothing is built.
- **Inventory filtered by Facet** ("my Magic stock, blue only, cheapest first"). Stock has no facet columns; named in [ADR 0008](adr/0008-mirror-is-two-read-models.md) so nobody designs it in by accident ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)).
- **Last-picked-set boost** in Large Buy / Ingest search. Results sort newest set first; `name SET` / `name #n` narrows ([#27](https://github.com/KeeprDigital/shop-keepr/issues/27)).
- **Realtime push.** Polling behind an interface; no Durable Object and no Ably for the MVP ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).

## 2. Architecture at a glance

One Nuxt 4 application, Nitro Cloudflare preset, deployed as a Worker. Everything below is Cloudflare or in-process.

| Concern        | Decision                                                                                                                                                                                  | Detail                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Platform       | Cloudflare end-to-end; Nuxt 4 + Nitro Cloudflare preset; Nuxt UI v4 for components                                                                                                        | §8, §7                                                                                                                      |
| Data           | **D1**, one database, **Drizzle** (`drizzle-orm/d1`); `store_id` on every table                                                                                                           | §4 ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2), [#20](https://github.com/KeeprDigital/shop-keepr/issues/20)) |
| Stock          | Append-only ledger, one table with a `kind` discriminator, header + lines; on-hand a materialised projection; available-to-promise computed on read                                       | §3 ([ADR 0001](adr/0001-append-only-ledger.md))                                                                             |
| Mirror         | Whole Catalogue mirrored into D1 (~150k Printings, ~60 MB); two read models: shared `printing` + one search table per Game System                                                         | §4 ([ADR 0008](adr/0008-mirror-is-two-read-models.md))                                                                      |
| Search         | Five-tier cascade in D1, issued as one `batch()`; typo tolerance per token                                                                                                                | §4 ([#24](https://github.com/KeeprDigital/shop-keepr/issues/24))                                                            |
| Catalogue seam | HTTPS only; per-consumer credential per environment; committed OpenAPI document from staging drives generated types, Zod schemas and runtime validation                                   | §5 ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23)) |
| Sync           | One cursor walk per Game System as a Cloudflare Workflow; seed, delta and reconcile are the same run; a second walk for price movements                                                   | §5 ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md))                                                            |
| Pricing        | Ordered pipeline over store settings, resolved attribute row → Game System → store default; prices stored as SKU columns; swept by a queue-backed job, recomputed inline on ledger append | §6 ([ADR 0004](adr/0004-configurable-pricing-pipeline.md))                                                                  |
| Holds          | D1 rows with `expires_at`; one conditional `INSERT … SELECT … WHERE` reserves atomically; lazy expiry on read plus a Cron Trigger sweeper                                                 | §7 ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4))                                                              |
| Realtime       | Polling behind an interface. No Durable Object, no SSE, no Ably for the MVP                                                                                                               | §7 ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4))                                                              |
| Auth           | Better Auth: staff email + password with a DB-backed session cookie; kiosk API key as an `HttpOnly; Path=/api/kiosk` device cookie                                                        | §7 ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3))                                                              |
| Currency       | Prices converted in shop-keepr on a fetched-but-stepped FX rate                                                                                                                           | §6 ([ADR 0003](adr/0003-stepped-exchange-rate.md))                                                                          |
| Tenancy        | One Store, hardcoded; no store switching, no scoped auth                                                                                                                                  | §1.3                                                                                                                        |
| Offline        | Not supported                                                                                                                                                                             | §1.3                                                                                                                        |

**Bindings the Worker needs** (named here so the deferred deployment work has its list): the D1 database; a Workflow for the Catalogue walk; a Queue for the pricing sweep; a Cron Trigger for the Hold sweeper (and the scheduled walks); secrets for the Catalogue credential per environment and Better Auth. Exact names are chosen during the build.

**Surfaces and routes.** Staff pages live under the sidebar shell at the root; the kiosk lives under `/kiosk` with its own layout; kiosk server routes live under `/api/kiosk` and are the only routes the kiosk credential can reach ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#3](https://github.com/KeeprDigital/shop-keepr/issues/3)).

## 3. Domain model and ledger schema

### Entities

Three-level ladder; confusing the rungs is the domain's commonest mistake ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).

| Entity                     | Is                                                              | Table                                 | Notes                                                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store                      | The business; one today                                         | `store`                               | `store_id` on every table from day one, hardcoded to one store, no UI, no scoped auth. Holds Default Tender, Tender Modifier, Hold TTL, default Language, trading currency, Pricing Rules.                                                                                |
| Card                       | The design; the thing with a name                               | none                                  | No Card table for the MVP; grouping search results is a query. Flips only if search grouping needs a stable id ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                               |
| Printing                   | A specific version of a Card, as the Catalogue defines it       | `printing` (Mirror)                   | Catalogue is sole origin. `printing_id` is the Catalogue's opaque identifier, stored verbatim, never parsed or constructed, unique across games ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)). |
| SKU                        | A Printing in a Condition and Language, held by one Store       | `sku`                                 | The unit counted, priced, held, transacted. Key `(store_id, printing_id, condition, language)`. Store-system term, never shop-floor ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                          |
| Ledger entry               | One Buy, Sell or Adjustment: header + lines                     | `ledger_entry`, `ledger_line`         | Implementation term; no domain noun; staff see only Buy, Sell, Adjustment ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                    |
| Transaction                | The act at the till: one customer, one POS Reference, one `net` | none (one or two `ledger_entry` rows) | A Trade is one Transaction recorded as a Buy entry and a Sell entry sharing `trade_id` ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46), [ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md)).                                                             |
| Basket                     | A kiosk customer's selection                                    | `basket` + lines                      | Not a Transaction; produces a Sell on Complete ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).                                                                                                                                                             |
| Hold                       | Reservation of a SKU by a Basket line                           | `hold`                                | No clock of its own; the Basket carries `expires_at` ([ADR 0006](adr/0006-basket-owns-the-hold-clock.md)).                                                                                                                                                                |
| Pinned Price               | A hand-fixed Sell or Buy Price on a SKU                         | columns on `sku`                      | Sell and Buy pinned independently; carries who and when ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).                                                                                         |
| Large Buy / Ingest session | A server-side pile being worked                                 | one session table, `kind`             | Large Buy commits as a Buy; Ingest as one Adjustment ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).                                                                                                                                                       |
| Customer List              | A customer-supplied card list, resolved by staff                | own table, not a session `kind`       | Never Holds, never freezes a price ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).                                                                                                                                                                         |

### Storage conventions

- D1, one database, Drizzle. Mirror tables and store tables share the database (no cross-database joins) but are namespaced apart ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2), [#6](https://github.com/KeeprDigital/shop-keepr/issues/6)).
- Money: integer minor units, one trading currency per Store, formatted at the edge only. Timestamps: epoch-ms integers ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- Internal ids are opaque ULIDs ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- Condition, Language, `Money` and error codes are defined once in `shared/`; the DB schema imports them ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
- `.batch()` is atomic but not conditional. Every statement that depends on an earlier conditional statement carries its own `AND EXISTS (...)` guard in SQL. Verified silent corruption otherwise ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).
- D1 caps that shape writes: 100 bound parameters per statement, 100 KB per statement, 5-member compound `SELECT`; no `batch()` statement-count limit found; ~20 ms Worker→D1 floor per query; ~400 serialised statements/s per database ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).

### Enums

Codes are never renumbered or reused; the ledger is permanent. Reason codes are kebab-case strings; the UI shows them in words ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).

| Enum                       | Values                                                                                                 | Notes                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Condition                  | `NM`, `LP`, `MP`, `HP`, `DMG`                                                                          | Fixed, one scale across every Game System, explicit sort order in that sequence. Not store-configurable; adding a grade is a release with a migration ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                   |
| Language                   | `en`, `ja`, `ko`, `fr`, `de`, `it`, `es`, `es-ES`, `es-419`, `pt-BR`, `zh-Hans`, `zh-Hant`, `x-phyrex` | BCP 47 tags, controlled list. `NOT NULL`; defaulted from the Store setting, resolved at write time by one shared normalisation rule ([ADR 0002](adr/0002-language-on-sku.md)).                                                                       |
| `kind`                     | `buy`, `sell`, `adjustment`                                                                            | Exactly three. No `trade`, no `ingest` kind ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35), [ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md)).                        |
| Adjustment Reason          | `miscount`, `damage`, `shrinkage`, `found`, `condition-regrade`, `initial-load`                        | Shrinkage is a Reason, not a kind. Ingest Reasons are `initial-load` and `found`, chosen once per session ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).                  |
| Reversal Reason            | `keying-error`, `customer-changed-mind`, `wrong-card`, `other`                                         | `other` requires a note. On any entry carrying `reverses` ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                               |
| `surface`                  | `staff`, `kiosk`                                                                                       | Who wrote the row. Mandatory on every ledger kind ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                       |
| `origin`                   | `kiosk`, `counter`, `list`, `large_buy`                                                                | What the Transaction was. Sell: `kiosk`, `counter`, `list`. Buy: `counter`, `large_buy`, `list`. Distinct from `surface` ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35)). |
| `tender`                   | `cash`, `credit`                                                                                       | Two values only; no `split` ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [ADR 0010](adr/0010-tender-and-total-factors-on-the-total.md)).                                                                                            |
| Basket state               | `open`, `submitted`, `fulfilled`, `cancelled`, `expired`                                               | No `picking`, no `abandoned` ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).                                                                                                                                                          |
| Basket line removal reason | `not-found` (default), `customer-declined`, `other`                                                    | On a line staff remove from a `submitted` Basket ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).                                                                                                                                      |
| `price_source`             | `rule`, `pinned`                                                                                       | Per side on `sku`. Exists so the sweep skips pins ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).                                                                                                                                       |
| Session `kind`             | `large_buy`, `ingest`                                                                                  | ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))                                                                                                                                                                                        |
| Session state              | `open`, `committing`, `committed`, `abandoned`                                                         | ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))                                                                                                                                                                                        |
| Customer List direction    | `buy`, `sell`                                                                                          | Chosen before paste, never mixed ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).                                                                                                                                                      |
| Customer List state        | `open`, `converted`, `abandoned`                                                                       | ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))                                                                                                                                                                                        |
| Customer List line state   | `resolved`, `unresolved`, `dropped`                                                                    | No Reason on `dropped` ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).                                                                                                                                                                |

### Mirror reference: `printing`

Read by stock, ledger, Baskets, sessions and repricing; the only Mirror table anything outside search touches ([ADR 0008](adr/0008-mirror-is-two-read-models.md)). Full column set is the Catalogue section's; the columns this section depends on:

| Column                                                                           | Notes                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                             | Catalogue's opaque Printing id, text, unique across games.                                                                                                                                              |
| `card_id`, `game_system`, `name`, set code, collector number, finish, image URLs | Display; ledger lines copy name, number, set and rarity as text at write time.                                                                                                                          |
| `market_price`, `market_price_updated_at`                                        | One rate per Printing; written only when moved. Never overwritten with null ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21)). |
| `withdrawn`                                                                      | Row stays; kiosk hides, staff see a badge, still sellable ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).                                                                                |

Per-game search tables (`mtg_printing`, …) and `printing_detail` are search's alone; no store table joins them ([ADR 0008](adr/0008-mirror-is-two-read-models.md)).

### `sku`

| Column                                  | Type           | Notes                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                    | ULID           |                                                                                                                                                                                                                                                                                                                                                      |
| `store_id`                              |                |                                                                                                                                                                                                                                                                                                                                                      |
| `printing_id`                           | text           | FK to `printing.id`, opaque.                                                                                                                                                                                                                                                                                                                         |
| `condition`                             | Condition      |                                                                                                                                                                                                                                                                                                                                                      |
| `language`                              | Language       | `NOT NULL`. Nullable rejected: SQLite treats each `NULL` as distinct in a unique index, so ~99% of rows would fail open and split one pile into several ([ADR 0002](adr/0002-language-on-sku.md)).                                                                                                                                                   |
| `on_hand`                               | int            | Materialised projection of `SUM(ledger_line.quantity)`; written in the same `batch()` as the ledger insert; never negative ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).                                                                                                 |
| `sell_price`, `buy_price`               | Money          | Stored so they sort and filter. Buy Price is the pipeline at quantity 1 under current `on_hand` ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).                                                                                                                            |
| `sell_price_source`, `buy_price_source` | `price_source` | Independent per side.                                                                                                                                                                                                                                                                                                                                |
| sell pin who/when, buy pin who/when     |                | `pinned_at` is load-bearing: alerts fire on age (default 90 days) and drift (default 25%) ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)). "Who" under the shared login is the audit pair below (`session_id`, nullable `staff_user_id`). Column names not fixed by ticket. |
| `priced_at`                             | epoch-ms       | Reprice watermark: sweep scope `sku.priced_at < printing.market_price_updated_at` ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).                                                                                                                                                                                                     |

- Unique index `(store_id, printing_id, condition, language)`.
- Row upserted at first Buy or Ingest commit (0 → n); that is when a never-held card gets a stored price. Never materialised speculatively; a Printing with no row is priced on read at on-hand 0 ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).
- Rows may exist at `on_hand = 0` to carry a pin; rows are never deleted. Sweep scope `on_hand > 0 OR pinned` ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- Every ledger append for a SKU recomputes that SKU's `buy_price` inline, one row, in the request ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).
- Pinned Prices: Re-pin (new value), Unpin, Keep (resets the age clock only). Open: whether Keep rewrites `pinned_at` or a separate column ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).

### `ledger_entry` (header)

One physical table, `kind` discriminator; header + lines because a Buy is one real-world event across many SKUs ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)). Rows are never updated or deleted, with one exception: `pos_reference` is editable afterwards ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).

| Column                | Buy         | Sell        | Adjustment   | Notes                                                                                                                                                                                                                                                                       |
| --------------------- | ----------- | ----------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  |             |             |              | ULID.                                                                                                                                                                                                                                                                       |
| `store_id`            | req         | req         | req          |                                                                                                                                                                                                                                                                             |
| `kind`                | `buy`       | `sell`      | `adjustment` |                                                                                                                                                                                                                                                                             |
| `created_at`          | req         | req         | req          | Commit time. No backdating; the POS Reference carries the true sale time ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).                                                                                                                                     |
| `surface`             | req         | req         | req          | `staff` / `kiosk`. The kiosk writes no ledger entry (Complete is a staff action), so MVP entries are `staff`.                                                                                                                                                               |
| `session_id`          | req         | req         | req          | Better Auth session; narrows to one shift on one terminal ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                                      |
| `staff_user_id`       | null        | null        | null         | Null until per-staff login; the column is the migration ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                                        |
| `origin`              | req         | req         | —            | See enum.                                                                                                                                                                                                                                                                   |
| `pos_reference`       | req         | req         | never        | Opaque non-empty string, not unique, editable, never validated ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).                                                                                                                                               |
| `basket_id`           | —           | null        | —            | Set on `origin = kiosk` ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).                                                                                                                                                                                      |
| `trade_id`            | null        | null        | —            | Same value on both halves of a Trade ([ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md)).                                                                                                                                                                              |
| `tender`              | req         | never       | never        | Pre-filled from Default Tender, flippable per Buy; always `credit` on a Trade Buy ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44)).                                                               |
| `tender_modifier_pct` | null        | never       | never        | Signed, as applied; 0 when `tender` equals Default Tender ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).                                                                                                                                                    |
| `total_pct`           | null        | null        | never        | Signed integer −100..+100, typed per Transaction, no setting. Null on kiosk Sells; set on counter and Customer List Sells and every Buy surface ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44)). |
| `remainder_tender`    | null        | never       | never        | Trade Buy only, when a Remainder exists ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).                                                                                                                                                                      |
| `total`               | req         | req         | never        | The side's own worth as settled; formula below ([#44](https://github.com/KeeprDigital/shop-keepr/issues/44)).                                                                                                                                                               |
| `net`                 | req         | req         | never        | Money that moved at the till; formula below ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44)).                                                                                                     |
| `reason`              | on reversal | on reversal | req          | Adjustment Reason, or Reversal Reason when `reverses` is set ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                                   |
| `note`                | opt         | opt         | opt          | Required with Reversal Reason `other`.                                                                                                                                                                                                                                      |
| `reverses`            | null        | null        | null         | FK to the entry this one compensates ([ADR 0001](adr/0001-append-only-ledger.md)).                                                                                                                                                                                          |
| `customer_name`       | opt         | —           | —            | Free text; no customer entity ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                                                                  |

Indexes: `(store_id, created_at)`; `(store_id, pos_reference)` (History is findable by POS Reference, [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)); `(store_id, trade_id)`; `(reverses)`.

### `ledger_line`

One row per SKU per entry, signed quantity ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).

| Column                                   | Notes                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `entry_id`, `store_id`             |                                                                                                                                                                                                                                                                                                                                                                                 |
| `printing_id`, `condition`, `language`   | The SKU key, carried on the line ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).                                                                                                                                                                                                                                                                                 |
| `sku_id`                                 | Resolved at commit after the upsert. Not fixed by ticket; index target for "what happened to this SKU".                                                                                                                                                                                                                                                                         |
| `quantity`                               | Signed. Buy positive, Sell negative, Adjustment either. A regrade is two balanced lines (−1 NM, +1 LP) in one Adjustment ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).                                                                                                                                                                                           |
| card name, collector number, set, rarity | Four plain-text columns, written once, never updated. Deliberate duplication of the Mirror so a five-year-old Buy reads "4x Monkey D. Luffy OP01-003 NM" with no lookup ([ADR 0001](adr/0001-append-only-ledger.md)).                                                                                                                                                           |
| `list_price`                             | Per copy. Buy: the SKU's Buy Price at the line's quantity and pre-buy on-hand. Sell: the SKU's Sell Price at commit, or the Basket line's snapshot on a kiosk Sell. Null on Adjustment ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48)). |
| `transacted_price`                       | Per copy, staff-editable; `list − transacted` is the discount; no discount entity. A line edit never changes the SKU price and never pins. Null on Adjustment ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).                                                                                       |
| unit price at quantity 1                 | Buy only. Snapshot of the pipeline at qty 1 for this SKU. Column name not fixed ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).                                                                                                                                                                                                                                  |
| quantity multiplier applied              | Buy only. The Quantity Band factor applied; the stock multiplier is inside the unit price and not separately recorded. Column name not fixed ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).                                                                                                                                                                     |

Indexes: `(entry_id)`; `(store_id, sku_id, entry_id)`.

Adjustment lines carry no price. Ingest never prices ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).

### Money semantics on the header

All figures signed from the store's perspective: a Buy negative, a Sell positive ([#44](https://github.com/KeeprDigital/shop-keepr/issues/44)).

```
tender_factor (Buy) = 1                          when tender = Default Tender
                    = 1 + Tender Modifier        credit when default is cash
                    = 1 − Tender Modifier        cash when default is credit
tender_factor (Sell) = 1

total = round( Σ(transacted_price × quantity) × tender_factor × (1 + total_pct/100) )
```

- Rounding once, last, by the side's rounding rule from the pipeline (increment + direction); Buy uses the Buy-side rule, Sell the Sell-side rule ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [ADR 0010](adr/0010-tender-and-total-factors-on-the-total.md)).
- Lines always show and store the Default Tender price; the other Tender is only ever a factor on the total, overridden lines included ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).
- `total` and `net` are snapshots: immutable, never recomputed, never used to derive anything. A partial reversal has its own `total` and `net` ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md)).
- Plain Buy or Sell: `net = total`.
- Trade: each side first (Sell's `total_pct` and rounding give S; Buy's Tender Modifier, `total_pct` and rounding give C, its credit value, and K, its cash value), then the split. No further rounding beyond the currency's minor unit ([#44](https://github.com/KeeprDigital/shop-keepr/issues/44)).

| Trade case                 | `remainder_tender` | `net` on both halves                |
| -------------------------- | ------------------ | ----------------------------------- |
| Customer pays (S > C)      | null               | `+(S − C)`, however the POS took it |
| Store owes, credit (C > S) | `credit`           | `−(C − S)`                          |
| Store owes, cash (C > S)   | `cash`             | `−K × (1 − S/C)`                    |
| Even (S = C)               | null               | `0`                                 |

Trade Buy header: `tender = credit` always (Covered is always credit); `remainder_tender` set only when a Remainder exists, defaulting to Default Tender; Total Percentage applies to the pile's value before the split ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44)). Worked: pile £100 cash / £125 credit, customer takes £80 → Buy `total −125`, Sell `total +80`, `net −45` (credit) or `−36` (cash). Cards worth £80 credit, customer takes £100 → `total −80` / `+100`, both `net +20`.

Store credit is a Tender, never a balance: no customer entity, no credit ledger ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).

### Write paths and atomicity

- One Sell service (kiosk Complete, counter, Customer List) and one Buy service (counter, Large Buy, Customer List via Large Buy). No other ledger writers for trade ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).
- A commit batch, in one `.batch()`: header insert; line inserts; `sku` upsert per line (Buy, Ingest); `on_hand` update per line with `AND EXISTS` guard; inline Buy Price recompute per touched SKU. POS Reference required before the batch on Buy and Sell ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).
- Trade: both services in one batch; two headers with the same `trade_id`, same `pos_reference`, same `net`, each its own `total`. Which entries a Transaction commits as is decided by which sides have lines; no "start a Trade" mode. Same SKU on both sides is a non-case ([ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).
- Large Buy: one atomic batch ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).
- Ingest: one Adjustment header, lines written in chunks under D1's caps; session `committing` until every chunk lands, resumable on failure. Open: per-line idempotency key for the resume ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).
- Sell bounds: blocked at `on_hand` 0 or below the quantity sold (link to a `found` Adjustment first). Bounded by `on_hand`, not available: selling through a Hold proceeds with a warning naming the Basket Number; the Basket takes the shortfall path ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).
- Kiosk Sell: `origin = kiosk`, `basket_id` set, one line per remaining Basket line at the snapshotted price, `total_pct` null; Holds released; Basket `fulfilled`. A Basket with every line removed cannot be completed ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- Declined or withdrawn cards are removed from the uncommitted Transaction and never recorded ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).
- Counter Transaction is browser-local until commit: no server row, no Holds ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).

### Corrections

Compensating entries only ([ADR 0001](adr/0001-append-only-ledger.md)).

- A correction is a new entry with opposite quantities, `reverses` pointing at the original, its own Reversal Reason, its own `total` and `net`. Nothing is edited or deleted.
- Same `kind` as what it reverses: a reversed Buy is a Buy with negative quantities, never a Sell.
- Partial reversal (2 of 4 returned) is an ordinary entry. Returns are compensating `sell` entries; workflow deferred to stock-corrections ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).
- UI: "Undo this Buy"; original greyed with a "reversed" chip linking to the reversal. "Compensating" never reaches the shop floor.
- Rejected: `voided` flag (mutates a row, makes correctness opt-in per query, loses audit, cannot express partial).

### On-hand projection and availability

```
on_hand   = SUM(ledger_line.quantity) per SKU, materialised on sku.on_hand
available = on_hand − COALESCE(SUM(hold.quantity) WHERE hold's basket.expires_at > now, 0)
```

- `on_hand` written in the commit batch, guarded per line. Available-to-promise is computed on read, never stored: storing it forces a write on every expiry ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [ADR 0001](adr/0001-append-only-ledger.md)).
- One availability query, one place; `expires_at` filtering never scattered across call sites ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).
- Predicate is strictly `expires_at > now`: a Basket expiring at exactly `now` is expired ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).
- Availability is exact, never advisory; it computes in the same query that filters and paginates search ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6)).
- Stock Bands key on `on_hand` before the transaction, Holds ignored, so kiosk Baskets never move a Buy Price ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

#### Reconcile job and `projection_drift`

Recomputes `SUM(ledger_line.quantity)` per SKU, writes the ledger's answer into `on_hand`, and records every heal to `projection_drift` (SKU, stored value, ledger value, timestamp). Cron plus on-demand from a staff screen. Empty table means healthy. A heal is never a ledger entry ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7)). Rejected: report-only (nobody notices), heal-only (erases the symptom).

### `basket`, Basket lines, `hold`

| `basket` column                                  | Notes                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                             | ULID, the identity.                                                                                                                                                                                                                                                                                             |
| `store_id`, `state`                              | Five states.                                                                                                                                                                                                                                                                                                    |
| `expires_at`                                     | The one clock; every Hold inherits it ([ADR 0006](adr/0006-basket-owns-the-hold-clock.md)).                                                                                                                                                                                                                     |
| `basket_number`                                  | Nullable until submit. Random three-digit `100–999`, unique per store among live Baskets (non-terminal plus `expired` within 24 h), redraw on collision, reused after; a display handle, never a lookup key outside the live set; kept on revive ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)). |
| `customer_name`                                  | Optional, captured at submit.                                                                                                                                                                                                                                                                                   |
| `created_at`, `submitted_at`, terminal timestamp | For the queue, the 24 h revival window, and cursor polling ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).                                                                                                                                                                                         |

Basket line (table name not fixed): `basket_id`, `sku_id`, `quantity`, snapshotted Sell Price at add (binding at fulfilment, the only record of what the customer was quoted), removal reason nullable ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10)). A Basket spans Game Systems ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).

`hold`: `id`, `store_id`, `sku_id`, `basket_id`, `quantity`. No `expires_at`. Recommended `UNIQUE(basket_id, sku_id)` as the idempotency key against a retried reserve after a timed-out commit ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).

Transitions ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)):

| From                                         | To          | Trigger                                          | Holds                                                                 |
| -------------------------------------------- | ----------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| —                                            | `open`      | first add at kiosk                               | created per line, clock = `basket.expires_at`                         |
| `open`                                       | `open`      | add / remove / qty change                        | clock reset to now + TTL                                              |
| `open`                                       | `submitted` | customer submits                                 | reset once; Basket Number issued                                      |
| `open`                                       | `cancelled` | customer clears, or kiosk idle 60 s + 30 s       | released immediately                                                  |
| `submitted`                                  | `fulfilled` | staff Complete: POS Reference required, ≥ 1 line | Sell written; released                                                |
| `submitted`                                  | `submitted` | staff removes a line (reason)                    | that line's Hold released                                             |
| `submitted`                                  | `cancelled` | staff cancel, no reason                          | released                                                              |
| `open` / `submitted`                         | `expired`   | `expires_at` passes (lazy on read; cron GC)      | released                                                              |
| `expired`                                    | `submitted` | staff Revive within 24 h                         | re-reserved per line under a fresh clock; lines that fail are dropped |
| `fulfilled` / `cancelled` / `expired` > 24 h | —           | terminal                                         | —                                                                     |

- TTL: default 20 min, range 5–120 min, one store setting. Runs down after submit with no reset and no manual extension, ever ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- Reservation is one conditional `INSERT … SELECT … WHERE available ≥ qty` reading the Basket's `expires_at`; atomic on D1 without `BEGIN`; verified 16,250 attempts, zero oversell, local and remote. `meta.changes = 1` wins, `0` loses; `0` is also what an unknown SKU returns, so the kiosk re-reads availability to choose the message. Loser sees "just gone", no waitlist ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17), [ADR 0006](adr/0006-basket-owns-the-hold-clock.md)).
- Terminal Baskets kept forever; the cron sweeper (1-minute Cron Trigger) GCs `hold` rows only ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).
- Shortfall: staff remove the line with a reason; the phantom-stock window until a separate Adjustment is knowingly open; reasoned removals are that worklist ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- Only the Basket owns Holds. Counter Transactions, Customer Lists and sessions create none ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#33](https://github.com/KeeprDigital/shop-keepr/issues/33), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).

### Large Buy / Ingest sessions

One table, `kind` (`large_buy` / `ingest`); table name not fixed ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).

| Column                                             | Notes                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `store_id`, `kind`, `state`                  |                                                                                                                                             |
| `name`, `details`                                  | Free text ("Dave's binder"); no customer record.                                                                                            |
| `reason`                                           | Ingest only: `initial-load` / `found`, chosen once per session.                                                                             |
| `origin`                                           | Large Buy only: `large_buy`, or `list` with a back-link to the Customer List ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)). |
| `committed_entry_id`                               | Link to the ledger entry once `committed`. Not fixed by ticket.                                                                             |
| audit: `created_at`, `session_id`, `staff_user_id` | Any staff member may abandon; abandoned kept, nothing touched stock.                                                                        |

Lines: `printing_id`, `condition`, `language`, `quantity`, per-line price override (Large Buy only). Duplicates (same Printing + Condition + Language) merge. Market Price is read live from `printing` at render, never snapshotted on the session. Ingest import: unmatched CSV rows stay on the session as a fix list; commit allowed with rows unfixed; matching runs as a Workflow with progress on the session ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).

### Customer List

Own table, not a session `kind`: a list converts into a session or a Sell rather than being one ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).

| Column                                                | Notes                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `id`, `store_id`, `direction`, `game_system`, `state` | Direction and game fixed before paste.                                              |
| `name`, `details`, `raw_text`                         | Free text; pasted text kept.                                                        |
| conversion link                                       | Session id (Buy) or `ledger_entry` id (Sell) once `converted`. Not fixed by ticket. |

Lines: raw line text kept, parsed quantity, `printing_id` nullable, state (`resolved` / `unresolved` / `dropped`). Resolution: exactly one Printing → `resolved`; many → `unresolved`, never guessed; Sell narrows candidates to Printings held, Buy never narrows by stock. Duplicates merge on the same Printing. Converting requires every line `resolved` or `dropped`. Prices live, never snapshotted; no Holds; kept forever. Sell fill: best Condition first in store Language until met, bounded by `on_hand`, shortfall shown per line. Open: whether the per-SKU fill split is stored on the list or recomputed at the Sell screen ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).

### POS Reference

- Required at commit on every Buy and every Sell, store-wide, no setting; never on an Adjustment ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- Captured after the POS has moved the money; opaque non-empty string; never validated against the POS; editable afterwards ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).
- Not unique: one receipt may cover a kiosk Basket plus counter extras, or a Buy and a Sell. Both halves of a Trade carry the same one ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md)).
- Two Customer Lists (sell-some, want-some) share one POS Reference as two Transactions ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).
- Rejected: optional-then-reconcile.

## 4. Data layer, Mirror read models and search

### 1. Engine: one D1 database, Drizzle

One D1 database holds everything: ledger, SKUs, Holds, Baskets, settings, auth tables, and the Mirror. Drizzle `drizzle-orm/d1` over `sqlite-core`, migrations via `drizzle-kit generate` → `wrangler d1 migrations apply`. D1 serves both axes, transactional store and search; no second vendor, no second write path, no search ask to the Catalogue ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2), [#20](https://github.com/KeeprDigital/shop-keepr/issues/20), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)).

Rejected: Postgres via Hyperdrive (query cache on by default with no write invalidation; does not run under `wrangler dev`; no `LISTEN`/`NOTIFY`; the only Worker-clean path, HTTP drivers, offers exactly D1's transaction model) ([#19](https://github.com/KeeprDigital/shop-keepr/issues/19)). Rejected: libSQL/Turso (recommended engine has no FTS5; `ATTACH` deprecated for new users; embedded replicas cannot run on Workers; interactive transactions produced 960 `SQLITE_BUSY` errors against D1's zero) ([#18](https://github.com/KeeprDigital/shop-keepr/issues/18)). Rejected: Durable Object SQLite as primary store (same 10 GB ceiling, no cross-object query) ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2)). Rejected: Orama (184 MB heap vs 128 MB isolate), Algolia (one ranking formula per index), Typesense (not needed; only hosted engine that would dissolve truncation, ~$29–50/mo) ([#25](https://github.com/KeeprDigital/shop-keepr/issues/25)). Rejected: a two-database split with a contentless FTS5 index elsewhere (caps candidates at top-N, loses exact name-plus-facet pagination) ([#16](https://github.com/KeeprDigital/shop-keepr/issues/16)).

#### Conventions

| Rule         | Detail                                                                                                                  | Source                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Money        | integer minor units                                                                                                     | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| Timestamps   | epoch-ms integers; never hand D1 a `Date`                                                                               | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| IDs          | opaque `text` ULIDs generated in app code ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10))                 | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| Tenancy      | `store_id` on every store-owned table, leading column of every composite index, hardcoded to one store                  | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| Namespacing  | Catalogue (Mirror) tables namespaced apart from store tables; sync job takes _a_ database binding, never _the_ database | [#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14) |
| Tables       | `STRICT`; derived columns are plain columns, never `STORED` generated (cannot be added to an existing table)            | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| Sessions     | `db.withSession()` from day one, replication off; library-owned tables (auth) stay off replication if ever enabled      | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| Plan         | Workers Paid (Free row caps hard-enforced since 2026-09-01; scrypt needs Paid CPU)                                      | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2), [#3](https://github.com/KeeprDigital/shop-keepr/issues/3)   |
| Location     | create with explicit `--location` hint for the store's region; cannot change later                                      | [#2](https://github.com/KeeprDigital/shop-keepr/issues/2)                                                              |
| Shared types | Condition, Language, `Money`, error codes defined once in `shared/`; DB schema imports them                             | [#9](https://github.com/KeeprDigital/shop-keepr/issues/9)                                                              |
| Auth tables  | Better Auth's built-in D1/Kysely path, not its Drizzle adapter                                                          | [#3](https://github.com/KeeprDigital/shop-keepr/issues/3)                                                              |

#### Measured limits every query must respect

All measured on local workerd and re-confirmed on real D1; `rows_read` and plans transfer exactly ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).

| Limit                           | Value                                                                                                   | Consequence                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Bound parameters per statement  | exactly 100, inside `batch()` too                                                                       | bulk writes inline escaped literals; chunk `IN` lists                                         |
| Statement length                | exactly 100,000 bytes (100,001 → `SQLITE_TOOBIG`)                                                       | pack to ~90 KB                                                                                |
| Compound `SELECT` members       | 5, undocumented                                                                                         | multi-select facets use `IN`, never `UNION`; cross-game screens never `UNION` per-game tables |
| `batch()` statement count       | no limit found to 100,000 (11.2 s)                                                                      | one `batch()` per seed page                                                                   |
| Query duration                  | 30 s, applies to a whole `batch()`                                                                      | not a constraint at this scale                                                                |
| Queries per invocation          | 1,000; 6 simultaneous connections                                                                       |                                                                                               |
| Database size                   | 10 GB, unraisable                                                                                       | ~412 MB all-in at 150k Printings                                                              |
| Cross-database access           | `ATTACH`, `DETACH`, `CREATE TEMP TABLE`, temp views all `SQLITE_AUTH`, permanent                        | Mirror and stock co-locate, always                                                            |
| Transactions                    | none interactive; `batch()` is atomic and sequential, **not conditional**                               | every dependent statement carries its own `WHERE … AND EXISTS` guard; check `meta.changes`    |
| Write retry                     | reads auto-retry twice; writes never                                                                    | ledger writes carry an idempotency key                                                        |
| Worker → D1 wall-clock          | ~20 ms floor per statement; anything under ~3,000 `rows_read` sits on it; ~35 ms client to counter      | issue dependent tiers as one `batch()` (§3.6)                                                 |
| Concurrency                     | single-threaded; 200 in-flight reserve statements cost ~500 ms each (~400/s)                            | irrelevant at one store                                                                       |
| Virtual tables                  | FTS5 (incl. `fts5vocab` two-arg form) and `rtree` only; `spellfix1`, `fts3/4`, `dbstat`, `csv` refused  | no edit-distance function, no custom functions                                                |
| `sqlite_version()`              | refused; engine ≥ 3.43.0 by feature probe                                                               |                                                                                               |
| `PRAGMA`                        | scoped to the current transaction                                                                       | never rely on `case_sensitive_like`; use `COLLATE NOCASE` index                               |
| Parameterised `name LIKE ?`     | no index unless the column carries a `COLLATE NOCASE` index (358 ms / 110,119 rows vs floor / 238 rows) | any `LIKE` prefix path needs that index; the cascade uses none                                |
| `OFFSET` pagination             | scans; `OFFSET 2000` = 2,020 rows, 21 ms remote                                                         | acceptable at storefront depths; keyset later                                                 |
| Multi-select `IN` facets        | ~25× a single facet's rows (27,543; 55 ms remote)                                                       | fine; know it before the filter UI grows                                                      |
| Partial indexes per Game System | supported, planner ignores them                                                                         | do not create                                                                                 |

#### Export and backup

An FTS5 table makes `wrangler d1 export --remote` fail for the **whole database**, schema-only too. `wrangler d1 export --table <name>` works for every ordinary table with FTS5 present (64,000-row table to 10 MB in ~10 s; two tables per call). Time Travel (30 days, minute granularity, in place, free) works ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17)). Build obligation: a scheduled ledger dump to R2 by table, since the ledger is the only irreplaceable data; the Mirror is a re-seed ([#16](https://github.com/KeeprDigital/shop-keepr/issues/16)). Billing is not a constraint: heaviest common query ~6,000 rows against 25 B included reads/month; full 150k re-seed ~1.35 M writes, 2.7% of monthly allowance ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13)).

### 2. The Mirror: two read models

The Mirror holds every Printing twice, split by who reads it. A shared `printing` table for identity and display, read by stock, ledger, Baskets, Large Buy/Ingest and repricing; one search table per Game System carrying typed Facets plus its own copy of the sort keys, read only by search. One sync module writes both from the same Catalogue record; neither holds a fact of its own ([ADR 0008](adr/0008-mirror-is-two-read-models.md), [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)). Rejected: one wide sparse table (equal performance, rejected on code clarity); per-game only (cross-game screens hit the 5-member compound cap); core plus facet-only extensions (filter and sort must share one physical index); key/value projection (112,803 rows read to return nothing) ([ADR 0008](adr/0008-mirror-is-two-read-models.md)).

#### `printing` (shared, no facet columns)

| Column                        | Notes                                                                                                                | Source                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                          | Catalogue's opaque Printing id, unique across games, stored verbatim, never parsed; the stock/ledger/Basket join key | [#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#15](https://github.com/KeeprDigital/shop-keepr/issues/15) |
| `card_id`                     | Catalogue's Card id; result grouping is `GROUP BY card_id`, no Card table                                            | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)                                                            |
| `game_system`                 |                                                                                                                      | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)                                                            |
| `name`                        |                                                                                                                      |                                                                                                                        |
| set, collector number, finish | column names Open (spike used `set_code`, `collector_number`, `finish`)                                              | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)                                                            |
| image URLs                    | Catalogue's CDN URLs, two sizes, one per face; nothing copied                                                        | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)                                                            |
| `market_price`                | integer minor units, written only when the value moved                                                               | [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)                                                            |
| `market_price_updated_at`     | epoch-ms; reprice watermark `sku.priced_at < printing.market_price_updated_at`                                       | [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)                                                            |
| `withdrawn`                   | flag; row never deleted; kiosk hides, staff badge, still sellable                                                    | [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)                                                            |

#### `printing_detail` (1:1, verbatim record)

`printing_id` primary key, the Catalogue's whole export record verbatim as JSON with Catalogue field names untouched, plus a content hash used by sync (hash match = read, not write). Read only on detail render; no `json_extract` in any hot query. Measured 2 KB stored per ~1.35 KB record: 304 MB at 150k Printings, ~400 MB at 200k; 64 rows per 90 KB statement ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)). Promoting a later Facet is a column, an index, a sync-extractor line and one migration on one table, no Catalogue round-trip.

#### Per-Game-System search tables

One table per game (`mtg_printing`, `pokemon_printing`, …; remaining names Open). Every row carries: `name`, `name_folded`, `name_folded_nospace`, the Double Metaphone key, set, collector number, `market_price`, plus that game's Facet columns, so a game-scoped filter + sort is one index. Market Price is written twice on every price pull, here and on `printing`. Each Game System is a module owning its table, Facet columns, index set, colour-to-column mapping and Pricing Attribute registry; nothing outside search imports it ([ADR 0008](adr/0008-mirror-is-two-read-models.md), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)). Open: the exact index set per table (handed to #14, which fixed only the write shape). Measured guidance: a covering index over the hot browse Facets + name + set + `market_price` takes a browse page from 1,146 to 60 rows read ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13)).

**Facets, MVP** ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)):

| Game System | Facets                                 |
| ----------- | -------------------------------------- |
| all         | set, rarity                            |
| Magic       | colour identity, card type, finish     |
| Pokémon     | card kind, energy type, stage, variant |
| One Piece   | colour, card type                      |
| Riftbound   | domain, card type                      |

Gameplay attributes (mana value, One Piece cost/attribute, Riftbound energy cost) are not Facets. Multi-valued Facets (colour identity, colour, domain): **one boolean column per value**, filter semantics _contains_; the Catalogue's list stays in the stored record for display. Card type: one per Printing; subtypes stay in the record. An unrecognised colour value goes to quarantine, run finishes `completed_with_drift` (revises #15's "fail loudly") ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Reference and settings tables

| Table                  | Columns                                                                                                                                                                                                          | Source                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `catalogue_set`        | game, code, name, release date; synced as records                                                                                                                                                                | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15) |
| `catalogue_vocabulary` | game, kind, code, label, sort order; rarities, colours, card types, variants; filter dropdowns read these, nothing hardcodes or `DISTINCT`-scans                                                                 | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15) |
| `store_game_system`    | store, game, `enabled`, display order; defaults enabled for every registered game; disabled game omitted everywhere but Settings (kiosk picker, game-scoped routes 404, staff lookup); disabled games still sync | [#15](https://github.com/KeeprDigital/shop-keepr/issues/15) |

**Pricing Attribute registry**: each game module declares a closed registry of pricing-capable attribute keys → column on its search table; settings offer only those; rule rows validated against it; reprice reads the column. MVP keys: rarity and finish/variant, all four games ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)).

Out of scope: Inventory filtered by Facet (drives from `sku`, which has no Facet columns). Fix is a third derived copy of Facets onto `sku`, post-MVP ([ADR 0008](adr/0008-mirror-is-two-read-models.md)).

### 3. Search: the five-tier cascade

One search serves kiosk, Lookup, Large Buy/Ingest and Customer List resolution ([#16](https://github.com/KeeprDigital/shop-keepr/issues/16)). Game-scoped first, always. Strict cascade, stop at the first non-empty tier; each lower tier is strictly noisier ([#24](https://github.com/KeeprDigital/shop-keepr/issues/24)). Two requirements, not one: **partial recall** (any-order token subset, 88.8% of names multi-token) is the hard MVP requirement and the larger share of misses; **typo tolerance** is a fallback tier with a lower bar ([#25](https://github.com/KeeprDigital/shop-keepr/issues/25)).

| Tier | Mechanism                                                      | Covers                                                                                            | Measured cost                                                                  |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | `name_folded = ?` exact, game-scoped                           | common case; accents, punctuation, smart quotes                                                   | 0.06 ms, 4 rows; a miss 0 rows                                                 |
| 2    | `name_folded_nospace = ?` exact                                | `farfetchd`, `hooh`                                                                               | one indexed column                                                             |
| 3    | FTS5 token-AND over folded text                                | partial recall any order, 83% / 100%                                                              | 39 rows, 3.5–19 ms D1 time                                                     |
| 4    | Double Metaphone key token-AND                                 | phonetic respelling 90%, romanisation 85%                                                         | one indexed column                                                             |
| 5    | per-token trigram fuzzy-resolve of the failed tokens, then AND | keyboard slip ~90%, transposition 92%, deletion 85%, insertion 100%; composes with partial recall | 222,579 rows table, 11.7 MB; 11,343 `rows_read` mean per token, 3–7 ms D1 time |

#### 3.1 Name folding

Rule, in order: NFKD → strip combining marks (`\p{M}`) → lowercase → **delete** apostrophes (`'`, `’`, `ʼ`, `‘`, `` ` ``) → every other non-alphanumeric run → one space → trim, collapse whitespace. NFKD not NFD, so untypeable symbols (`δ`, `◇`, `★`, `♀`, `®`) decompose to nothing and fall out; `Beedrill δ` folds to `beedrill`. `name_folded_nospace` = the same with spaces removed, looked up only when tier 1 misses. Two keys, not one: one key trades `Farfetchd` against `Ho Oh` and tops out at 77%; two keys reach 100% on accent, punctuation-deleted, punctuation-to-space and curly-quote classes at 0.20% collision (76 of 38,001, largest bucket 2) ([#25](https://github.com/KeeprDigital/shop-keepr/issues/25), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)). Open: the measured spike keeps all Unicode letters/digits (`[^\p{L}\p{N}]+`); the scaling script uses `[^a-z0-9]+`, which drops non-Latin letters. Pick the Unicode form unless a ticket says otherwise. Apply the same fold to the query string.

The fold and metaphone rule ships as a **shared, versioned library** (~15 lines), usable by any Catalogue Consumer; no Catalogue search ask, #23 carries no search item. Derived columns are computed in shop-keepr at sync time; if the Catalogue later exports folded columns, mirror them instead ([#24](https://github.com/KeeprDigital/shop-keepr/issues/24)).

#### 3.2 Double Metaphone

`double-metaphone@2.0.1` (MIT), **primary** key per token, computed on the folded form, tokens joined by a space. Phonetic mechanism only: 22% on a QWERTY slip, 33% deletion, 46% transposition; never describe it as typo tolerance. Collision 3.4% of names, p99 bucket 2, largest 11 ([#25](https://github.com/KeeprDigital/shop-keepr/issues/25)).

#### 3.3 FTS5 (tier 3)

Verified on D1: all four tokenizers, `prefix=`, `content=''`, `contentless_delete=1`, `columnsize=0`, external content with `content_rowid`, triggers, `bm25()`/`rank`/`snippet()`/`highlight()`, prefix and phrase queries ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13)). The spike shape: `CREATE VIRTUAL TABLE … USING fts5(name, …, content='<table>', content_rowid='rowid')`, default `unicode61` tokenizer, queried `WHERE fts MATCH ?1 ORDER BY rank LIMIT 20` joined on `rowid`. Tier 3 is token-AND over folded text ([#24](https://github.com/KeeprDigital/shop-keepr/issues/24)). Open: exact declaration per game search table (external-content over `name_folded` vs contentless), whether `prefix=` is set for typeahead. **An external-content index does not follow its base table**: a rename left the index matching the old name, silently. The sync module writes the FTS index explicitly on every delta (a `'delete'` command row then reinsert, or triggers) ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)). A separate `tokenize='trigram'` FTS index gives mid-name substring search at 19 rows; not a cascade tier, Deferred ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13)).

#### 3.4 Per-token trigram table (tier 5)

Shape, as measured on real D1 ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)):

```sql
CREATE TABLE token_trigram (trigram TEXT NOT NULL, token TEXT NOT NULL) STRICT;
CREATE INDEX token_trigram_covering ON token_trigram (trigram, token);
-- per failed query token:
SELECT token, COUNT(*) AS c FROM token_trigram
WHERE trigram IN (?1, ?2, …) GROUP BY token ORDER BY c DESC LIMIT 10;
```

One row per (trigram, distinct folded token) across the whole vocabulary; token padded with two spaces each side, `len + 2` trigrams per token. 23,600 tokens → 222,579 rows at 38,001 names, built in 1.3 s. Per distinct **token**, not per name (634,802 rows) and not per Printing (2,515,715 rows); cost tracks vocabulary, Heaps' law `V = 20.4 · N^0.673`, so 500k names is ~1.31 M rows and ~45–68k rows read per 2–3 token query, extrapolated. Only tokens that failed exact resolution are fuzzed (`mind sculper` fuzzes `sculper` alone); the resolved token sets are AND-ed. Plan: covering-index search then two temp B-trees; D1 counts the temp B-tree traffic as reads, so `rows_read` is 2.8× the posting-list arithmetic (mean 11,343, p95 19,873 per token). **Tuning lever held in reserve**: query only the 5 rarest trigrams per token, 412 rows mean, 28× cut, at some recall. Open: minimum token length to fuzz (the spike sampled tokens ≥ 5 chars; 17.3% of real tokens are ≤ 3 chars). Never measure trigram behaviour on a generated corpus (#13's overstates by 5.5×); use `spike/typo-search/data/all-card-names.json`.

#### 3.5 Ranking and the latency bar

Every figure is recall; rank-1 ordering is untested and accepted as a known risk. If it disappoints, the fix is a scoring function inside D1: `bm25()` on tier 3, length-normalised overlap on tier 5 ([#24](https://github.com/KeeprDigital/shop-keepr/issues/24)). Bar: ~100 ms p95 on the kiosk typeahead round trip disqualifies an option; recorded against re-litigation. On the kiosk a tier-5 correction is silent, and a miss never searches other games ([#28](https://github.com/KeeprDigital/shop-keepr/issues/28)).

#### 3.6 The `batch()` rule

Every statement pays ~20 ms; a cascade issued tier by tier pays 20 ms per tier. The cheap tiers cost 0 rows when they miss, so **issue all five tiers as one `batch()`** and take the first non-empty result in the Worker. Costs at most one fallback's rows, saves up to 80 ms ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)).

### 4. In-stock filter, sorting, pagination

Stock is exact, never advisory; available-to-promise computes in the same query ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6)). The load-bearing shape, verified at 6,042 rows / 40 ms remote at 4,000 SKUs ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)):

```sql
SELECT p.id, p.name, …, s.condition, s.on_hand, s.sell_price
FROM sku s JOIN <game>_printing p ON p.id = s.printing_id
WHERE s.store_id = ?1 AND s.on_hand > 0 AND <facet predicates>
ORDER BY s.sell_price ASC LIMIT 20 OFFSET ?;
```

Available-to-promise variant replaces `on_hand > 0` with `on_hand - COALESCE((SELECT SUM(h.quantity) FROM hold h JOIN basket b ON b.id = h.basket_id WHERE h.sku_id = s.id AND b.expires_at > ?now), 0) > 0`; measured at 9,282–9,502 rows with a per-Hold `expires_at` index, before ADR 0006 moved the clock onto the Basket. A `COUNT(*)` twin supplies the result total. Indexes on the store side: unique `(store_id, printing_id, condition, language)`, `(store_id, sell_price)`, `(printing_id)` ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).

| Surface             | In-stock filter                                                                                          | Source                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Kiosk               | on by default; per-Printing rows, "Group versions" switch default on, price range across held Conditions | [#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28) |
| Lookup              | off, so found-but-out-of-stock reads as found; "Group by Card" switch default off                        | [#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46) |
| Customer List, Sell | candidates narrowed to Printings held; Buy never narrows by stock                                        | [#33](https://github.com/KeeprDigital/shop-keepr/issues/33)                                                              |

**Empty-facet tail**: the price-ordered walk of `sku` has no early stop when the Facet matches nothing. 43 ms / 7,510 rows at 4,000 SKUs; **408 ms / 112,803 rows** at 60,000 SKUs remote. A planner deficit, not a schema error. Remedy (Facets denormalised onto `sku`, `(store_id, game_system, <facets>, sell_price)` index) takes it to 19 ms / 0 rows; post-MVP, trigger at five-figure SKUs ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#19](https://github.com/KeeprDigital/shop-keepr/issues/19), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)). Cross-game screens (Basket, ledger, queue, Large Buy) read `printing` by `printing_id` only, never the per-game tables ([ADR 0008](adr/0008-mirror-is-two-read-models.md)).

### 5. Seed size and timing (real D1)

One `batch()` per page, inline literals, ~90 KB per statement, indexes built **after** the seed (each `CREATE INDEX` writes 150,001 rows; 7 `rows_written` per Printing once indexed vs 2 bare) ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

| Load                                     | Rows / statement | Page                                    | Total |
| ---------------------------------------- | ---------------- | --------------------------------------- | ----- |
| `printing`, 16 columns, ~230 B/row, 150k | 392              | 20,000 rows = 51 statements, 0.5–1.2 s  | 5.2 s |
| `printing_detail`, 150k                  | 64               | 10,000 rows = 156 statements, 1.3–3.4 s | 36 s  |
| eight indexes                            |                  |                                         | 2.3 s |
| FTS5 external-content                    |                  |                                         | 0.4 s |
| FTS5 trigram tokenizer                   |                  |                                         | 3.3 s |
| `token_trigram` + covering index         | 4,637            | one batch                               | 1.3 s |
| `sku`, 60,000 rows                       | 1,333            | 33 statements, one batch                | 0.3 s |

Storage at 150k Printings: 35 MB bare; 108 MB with every index and search structure (+33 MB indexes, +7.6 MB FTS5, +17 MB trigram FTS5, +11.7 MB `token_trigram`); +304 MB `printing_detail`; **412 MB total**, ~4% of the ceiling. Price-only `UPDATE` = 2 writes per row. The Printing count itself is uncensused; 150k is an order of magnitude ([#5](https://github.com/KeeprDigital/shop-keepr/issues/5), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).

## 5. The Catalogue seam: contract, sync, and building before the Catalogue is ready

### The seam rule

**The Catalogue asserts observations about a Printing; shop-keepr asserts policy.** An observation is true of a Printing regardless of who is asking. Policy is what this store does about it. Both repos are ours; the boundary survives common ownership. "Both repos are ours" is never a reason to push a field across. The rule says which _side_ an observation belongs on, not whether the Catalogue must carry it at all; scope is a separate judgement ([ADR 0005](adr/0005-catalogue-observes-shop-keepr-decides.md), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

| Catalogue-side (observation)                             | shop-keepr-side (policy)                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Market Price                                             | Condition and Language multipliers                               |
| Rarity and other per-game Pricing Attributes             | Pricing Rules, Floors, margins, rounding                         |
| Printed text, images, set, variation                     | Which Game Systems the kiosk shows                               |
| Lifecycle and withdrawal                                 | What the store stocks; prices it charges                         |
| Normalised rarity (derived, but true for every consumer) | Exchange rate (an observation about the _world_, not a Printing) |

The awkward cases are derived observations (normalised rarity). They sit Catalogue-side because they hold for every consumer ([ADR 0005](adr/0005-catalogue-observes-shop-keepr-decides.md)).

### The requirements file is the only Catalogue-facing input

`docs/catalogue-requirements.md` is the whole demand shop-keepr places on the Catalogue, readable as one set. shop-keepr states requirements there; card-keepr schedules them; no negotiation. Requirements become card-keepr issues when it schedules the work: the file is the source, the issues are the scheduling surface. A requirement that asks the Catalogue to hold a shop-keepr policy is rejected by ADR 0005 ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23), `docs/catalogue-requirements.md`).

**Standing rule.** card-keepr's present code, routes, schemas, environments and issue tracker are never an input. Every decision below is stated as what shop-keepr _requires_, not what the Catalogue serves today. A builder who finds the live API disagreeing with this section files a requirement; they do not adapt the build ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).

**What survives of the spec discovery ([#5](https://github.com/KeeprDigital/shop-keepr/issues/5)).** The Catalogue is `KeeprDigital/card-keepr`, a sibling under our org, deployed at `https://card.keepr.digital/api`. Everything else that ticket recorded (artefact paths, route list, Revisions, NDJSON exports, `lifecycle{}`, rate limits, `SupportedGame`, the ~150k row figure) describes its shape on one day and is superseded by the standing rule. No shop-keepr credential existed at that point; one per environment is required below. The "150k printings" number has no census behind it and is never quoted as fact ([#5](https://github.com/KeeprDigital/shop-keepr/issues/5), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

### What the Catalogue must supply (contract)

| Requirement        | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change delivery    | One paged endpoint per Game System over full records (Printings, sets, vocabularies), ordered by a cursor the Catalogue issues. Cursor is **opaque** (stored and returned verbatim, never parsed), **monotonic**, **exhaustive** (nothing at or before a cursor arrives after it). From cursor zero returns everything. The Catalogue may back it with timestamp + tiebreak or a commit sequence; shop-keepr does not care. Rejected: wall-clock `updated_at` as the wire form (late writes and millisecond ties across a page boundary lose records); immutable Revisions consumed locally (every delta a full download + compare); snapshot for seed plus cursor for delta (two contracts). ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)) |
| Withdrawal         | Arrives as a record flagged `withdrawn` with a change cursor like any other change. Never inferred from absence. ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Market Price       | One rate per Printing, on the Printing record, with the cursor at which it last moved. A second walk on the same cursor rules returns price movements only. Not per Condition, not per Language. ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pricing Attributes | Per-game, matchable by string compare without interpretation. Absent or null values are normal and never fail ingest. ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Facet attributes   | Set and rarity everywhere; Magic colour identity, card type, finish; Pokémon card kind, energy type, stage, variant; One Piece colour, card type; Riftbound domain, card type. Multi-valued as a list of codes. Full record exported so a later Facet is promoted from the stored record. ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15))                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Card identifier    | `card_id` on every Printing; grouping is a query over Printings, no Card table. ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Vocabularies       | Sets (code, display name, release date) and each Facet's value list (code, display name, sort order) per Game System, exported as records. ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Images             | Stable CDN URLs on every Printing, thumbnail + full, one per face. Rendered from the Catalogue's host; nothing copied. ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| OpenAPI document   | Generated from the implementation, served at a stable path in every environment, describing walked records as well as routes. ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Access             | Per-consumer identity (a `Consumer` with N active `ApiKey`s, scopes covering at minimum Game Systems and bulk-export inclusion, rate limit and quota keyed on the Consumer). shop-keepr is Consumer #1. Wire format stays `Authorization: Bearer`. Filed as card-keepr#269; card-keepr's design to make. ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23))                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Credentials        | One per environment: local, dev, staging, production. ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Environments       | Dev, staging, production independently addressable. ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Coverage           | Magic and Pokémon. Supply, not contract; does not block the build. ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Transport: HTTPS, one mechanism for every call site.** Five call sites cross the seam: bulk seed, Catalogue delta, Market Price walk, undescribed-card resolution (live, at the API), Printing images (browser to CDN). Decided on the four-environment matrix, not latency: two transports means two code paths tested twice. Rejected: a Cloudflare service binding (costs deployment independence and cross-environment uniformity); a shared bearer secret (no identity, runbook rotation, total blast radius); Cloudflare Access service tokens (consumers must live in our Zero Trust org, no scopes, no metering). The credential format is not the decision; per-consumer identity is, because it is expensive to retrofit ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

### The contract layer

1. **One artefact.** The Catalogue's generated OpenAPI document describes routes and walked record shapes in one file. Rejected: a published client package from the Catalogue (couples release cadence across repos) ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
2. **Staging's document is the committed copy.** Tests gate against staging, so staging's contract is the one that must be true. Staging-to-production drift is the Catalogue's promotion concern, not checked here ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
3. **One pinned generator, TS types + Zod 4 schemas.** hey-api or typed-openapi (both emit TS and Zod 4 from OpenAPI 3.1; both pre-1.0, pin exact versions). `pnpm catalogue:contract` fetches the document, regenerates, and commits document + output. CI asserts the committed output is fresh. Rejected: generated full clients (machinery for a handful of operations); hand-written schemas (silent drift) ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
4. **Hand-written sync module, one code path selected by configuration.** The module takes `{ fetch, baseURL, credential }`. Production passes the Worker's `fetch`; tests pass a `fetch` serving committed fixture files by path (`ofetch.create({ fetch })` supports this). Nuxt's `registerEndpoint` does not help: it intercepts relative or exactly-registered paths only and sends absolute URLs to the network; its documented workaround is a second code path. The Workers vitest pool dropped `fetchMock`; MSW is the recorded fallback if a browser-level test ever needs the fixture. Fixture contents regenerate whenever the committed document changes ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
5. **Runtime validation of every pulled record.** Each record is parsed against the generated Zod schema at ingest. A failure writes the raw payload to the quarantine table and the run continues. Route-level contract tests run against staging on top ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
6. **Contract change is a reviewable diff.** Drift surfaces two ways: generated types (build error) and runtime validation in contract tests (test failure). The second catches an API not matching its own spec. No dev canary: the diff covers shape drift; behaviour drift is speculative until it bites once, then add a non-blocking check that opens an issue ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).
7. **Testing `server/api`.** Routes cannot be unit-tested in the `nuxt` vitest environment; only through the e2e runner, which builds the Worker under the Cloudflare preset and serves it with `wrangler dev` against the local D1 ([#54](https://github.com/KeeprDigital/shop-keepr/issues/54)). The sync module's hash-compare, quarantine and cursor-ordering rules are unit-testable against the fixture; the Workflow itself only through the e2e runner ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

### Sync: one cursor walk

**One job fills, refreshes and heals the Mirror.** Seed = Catalogue run from cursor zero into an empty Mirror. Delta = from the stored cursor. Reconcile = from cursor zero into a full Mirror. Hash-compare on every write makes all three one code path ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md)).

#### Run kinds and execution

|                              | Value                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow class input         | `{ kind: catalogue \| market_price, game, fromCursor }`                                                                                              |
| Cursor storage               | Per `(kind, game)`. Games walked in turn.                                                                                                            |
| Order within a Catalogue run | Sets and vocabularies before Printings (an unrecognised colour is judged against them)                                                               |
| Execution                    | Cloudflare Workflow, one step per page; step returns the next cursor only (1 MiB step-return cap forbids returning the page)                         |
| Verified limits              | 10,000 steps per instance; no instance-duration cap; per-step retries with exponential backoff; status by instance id; startable from a Cron Trigger |
| Failed halfway               | Platform resumes at the last completed page                                                                                                          |
| Operator escape hatch        | D1 HTTP import API (5 GiB SQL, blocks the database) for a first seed only; not the design                                                            |

Rejected: Queues (15 min per batch), self-chaining cron handler (15 min wall-clock), operator-only seed script (reconcile needs the same full pass unattended). If a Workflow limit moves, the shape (cursor per step, hash-compare) transfers to a Queue consumer unchanged ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Write shape

- Each record writes `printing`, `printing_detail`, the game's search table, **and its FTS index explicitly** (an external-content FTS5 index does not follow its base table) ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#13](https://github.com/KeeprDigital/shop-keepr/issues/13)).
- `printing_detail` stores the full record verbatim plus a content hash. Hash match = read, not write. Rebuild never truncates; a full walk against a live Mirror is safe; a bad release is undone by walking again. A hash mismatch on a full walk is **drift**, counted and recorded ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md)).
- Inline escaped literals, not bound params (100-param cap gives 6 rows per statement) ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).
- Measured on real D1: 392 Printing rows per 90 KB statement (64 for a ~1.35 KB `printing_detail` record); a 20k-row page is one `batch()` of 51 statements in 0.5–1.2 s; 150k seed in 5.2 s; no `batch()` statement-count limit up to 100,000; 100 KB statement cap exact; 30 s cap not a constraint. `rows_written` is 7 per Printing once catalogue indexes exist, so **build indexes after the seed**. FTS5 breaks `wrangler d1 export` for the whole database; `--table` export works ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).
- Job takes a database binding, never the database (tenancy hook) ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Idempotency, ordering, lock

`sync_run` table: kind, game, status, cursor from and to, records seen / written / quarantined / drifted, error, Workflow instance id, `finished_at`. It is history **and the lock**: one `running` row per kind, claimed by conditional `UPDATE` in D1, no Durable Object. A record applies only if its cursor ≥ the stored one. Re-running any page is a no-op. A `running` row older than 2× the expected duration is abandoned. Statuses include `running`, `completed_with_drift` (others per build; see Open) ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Cadence

| Run                             | Default interval     |
| ------------------------------- | -------------------- |
| Catalogue delta                 | 6 h                  |
| Market Price                    | 24 h                 |
| Reconcile (Catalogue from zero) | Weekly, Sunday night |

A Cron Trigger every 15 min starts the Workflow for any kind that is due. Intervals are store-scoped settings with defaults, **not surfaced** in the MVP UI. Staff see "prices as of <time>" from `sync_run.finished_at`, never from the cursor. Every number is a default chosen without a census ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Price recompute is watermark-driven

The Market Price run writes `printing.market_price` only when the value differs, so `market_price_updated_at` means _moved_. The reprice job (the queue-backed sweep, same evaluator) runs with scope `sku.priced_at < printing.market_price_updated_at`, within `on_hand > 0 OR pinned`. Nothing is enqueued per record. A missed reprice self-heals on the next sweep. A price movement for a Printing the Mirror lacks is skipped and counted ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).

#### Failure posture

- **Quarantine, never fail the run.** A record failing schema validation, or carrying a vocabulary value that needs a column of its own (a new colour), goes to the quarantine table with its raw payload. The run finishes `completed_with_drift`; the banner names count and reason. A new Magic colour must not freeze Pokémon prices. Quarantined records clear themselves: the next reconcile re-reads them and they validate once the release lands. This revises the "fail sync loudly on a new colour" wording in `docs/catalogue-requirements.md` ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).
- **Run isolation.** A failed or quarantining Catalogue run never stalls the Market Price run; separate cadences, triggers and cursors ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).
- **Absence is not withdrawal.** A Printing the Mirror holds that a full walk does not return is drift, logged, row untouched ([ADR 0009](adr/0009-catalogue-change-is-one-cursor-walk.md)).
- **Null Market Price.** Never overwrite a good rate with a null; keep serving the last known value with its `updated_at` visible; log loudly. Rejected: failing the sync; blocking the SKU from sale ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).
- **The walk is only as correct as the Catalogue's cursor guarantee.** Nothing on shop-keepr's side detects a violated guarantee except the weekly reconcile's drift count, which is why reconcile exists ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Withdrawn Printings

Row stays; `withdrawn` flips. Kiosk: hidden always. Staff: visible with a badge, still sellable at the counter (the physical card wins). Inventory offers withdrawn-with-stock as a filter chip. No `replaced_by` pointer for the MVP. Deferred: a worklist of withdrawn Printings the store holds (stock-corrections fog) ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).

#### Observability and operations

- **System page** (staff-login-protected): `sync_run` history; "Catalogue synced X ago / prices as of Y"; **Refresh now** (delta) and **Rebuild** (Catalogue run from zero) buttons ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).
- **Banner** on every staff screen when either run exceeds 2× its interval or last failed, linking to System. One banner slot; staleness beats reprice ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).
- Workers logs. No pager, no email for the MVP ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).
- **Local full Mirror on demand:** `pnpm catalogue:seed` runs the Workflow under `wrangler dev` against local D1, pointed at Catalogue staging through the `{ fetch, baseURL, credential }` seam. No snapshot artefact ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

#### Bindings needed

Workflow binding; Cron Trigger (15 min); D1 binding passed to the job; per-environment Catalogue credential as a secret; queue for the reprice sweep. Wrangler config per environment is deployment fog ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

### Market Price on the consumer side

- **Grain:** one rate per Printing. Condition and Language are rule inputs; an English and a Japanese copy of one Printing start from the same rate. Condition multipliers, never a supplied per-condition price ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).
- **Storage:** `printing.market_price` (current rate, Catalogue currency, integer minor units) plus `market_price_updated_at`. Nothing more; history stays in the API and is not read through in the MVP. Trend indicator out of the MVP ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).
- **Role:** input to both the Sell and the Buy rule. Staff-visible; never customer-visible. The kiosk response schema structurally has no slot for it ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
- **FX conversion happens in shop-keepr on a stepped rate.** The exchange rate is fetched on a schedule, held as a discrete versioned value, applied only when it moves past a threshold (default **2%**), settable by hand, and unchanged between steps. Crossing the threshold triggers a full reprice as a deliberate, logged event. FX is the first pipeline step. Rejected: converting at the source (every FX tick becomes a change on every Printing); live FX (retail stability across browse-wander-return, explicability as `market x condition multiplier x FX`, a second live dependency, precision below rounding); purely manual (rots). "Live FX forces an expensive sweep" is not a reason; the sweep is bounded by the store's SKU count ([ADR 0003](adr/0003-stepped-exchange-rate.md), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- **Provenance:** reconstructing a past shelf price needs the FX version in force then. Transacted prices are safe regardless: every Transaction snapshots its price ([ADR 0003](adr/0003-stepped-exchange-rate.md)).
- **Accepted gap:** which market the supplied rate reflects was never established. Store-level multipliers are the lever if it diverges ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).

### Game System coverage stance

- The store trades **Magic: The Gathering, Riftbound, One Piece, Pokémon**; all four in the MVP; singles only ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).
- **No gating on coverage.** shop-keepr contains no code assuming a particular Game System exists and does not block on what the Catalogue carries. Coverage is supply, not architecture ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).
- **The Catalogue is the sole origin of a Printing, permanently.** No locally-created Printing, no staff-invented card, no escape hatch in Buy entry. An undescribed card is fixed in the Catalogue. Rejected: local Printings (second creation flow, merge problem, stock rows with no Market Price or Facets, an escape hatch that becomes the main road) ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).
- **Adding a Game System is a rare, explicit, planned release.** Per-game code and per-game schema are permitted; a migration per game is acceptable; nothing on search speed or code clarity is conceded to make adding cheap. Rejected: zero-touch game addition as data ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).
- **Kiosk game picker is a store setting** (`store_game_system` rows), default all on; a disabled Game System is omitted everywhere but Settings ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22), [#15](https://github.com/KeeprDigital/shop-keepr/issues/15)).
- English only; region leaves the model ([#22](https://github.com/KeeprDigital/shop-keepr/issues/22)).

### Environments and test tiers

| Tier             | Runs against                            | When                |
| ---------------- | --------------------------------------- | ------------------- |
| Unit / component | Committed fixture, offline              | Every commit        |
| Contract         | Committed OpenAPI + fixture, no network | Every commit        |
| Integration      | Catalogue **staging**                   | Merge gate          |
| Exploratory      | Catalogue **staging**                   | By hand             |
| —                | Production                              | **Never automated** |

Integration goes to staging on grounds of **role**: dev is the owning team's inner loop and exists to be broken, so a consumer's red build against it says nothing. Staging is consumer-facing, pinned to a deliberate commit. The split holds with one owner ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

**The committed fixture is the load-bearing tier**, not a stand-in. A local card-keepr starts with an empty catalogue and no seed script: a real API serving nothing. The fixture must contain, as a starting point expected to grow ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)):

- more than one Game System
- several Printings of the same Card
- at least one withdrawn entity with lifecycle populated
- two Cards sharing a name
- non-Latin and awkwardly long names
- one game's full Facet range
- one Printing with a Market Price and one without

It does not test scale and must not pretend to ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

**Identity and credential.** shop-keepr is Consumer #1 with its own identity. One credential per environment (local, dev, staging, production), held as a Worker secret, rotated by adding a key and revoking the old (N active keys per Consumer) ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).

### The development loop while the Catalogue lacks features

1. Build against the committed fixture and the committed OpenAPI copy. The fixture is regenerated whenever the committed document changes ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9)).
2. Where the fixture needs a shape the Catalogue does not yet serve (a Market Price field, a `withdrawn` flag, a Pricing Attribute), the shape comes from `docs/catalogue-requirements.md`, not from the live API. Add the requirement there first if it is missing; the fixture follows the requirement ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).
3. Requirements are filed as card-keepr issues when card-keepr schedules them. There is no ask list and no deadline race; "we can change it" is not "it is changed", so shop-keepr's build can outrun the Catalogue's queue. That is a schedule concern, not an architectural one ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).
4. The merge gate against staging is only as useful as staging is current; nothing verifies pinning cadence ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).
5. The window in which shop-keepr shapes the Catalogue closes when the Catalogue is considered ready for market; after that, store-agnosticism becomes a product constraint and the ADR 0005 rule hardens ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23), [ADR 0005](adr/0005-catalogue-observes-shop-keepr-decides.md)).

## 6. Pricing: pipeline, store settings, and the settings page

Sell Price and Buy Price are produced by **one evaluator** folding an ordered list of steps over the Printing's Market Price. Step values _and_ step order are store settings. There is no pricing formula in code: the arithmetic lives in settings, the evaluator only applies it. Every caller (sweep, inline recompute, counter, Large Buy, Customer List, kiosk) uses the same evaluator, so a price is the same number wherever asked ([ADR 0004](adr/0004-configurable-pricing-pipeline.md)). Rejected: hardcoded formula (store's stated needs already exceed it); expression language (can express something that does not compute, failure lands on a shelf price) ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).

Money is **integer minor units**, one trading currency per Store, formatted at the edge only ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)). Buy and Sell are priced **independently with their own settings throughout**; a Sell Floor never touches a Buy Price ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

### The pipeline

#### Inputs

| Input                    | Source                                                                    | Notes                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market Price             | `printing.market_price` (Catalogue currency) + `market_price_updated_at`  | One rate per Printing; Condition and Language are rule inputs, not Catalogue dimensions ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)) |
| FX rate                  | stored stepped rate (see FX below)                                        | Catalogue currency → store currency ([ADR 0003](adr/0003-stepped-exchange-rate.md))                                                                   |
| Game System              | the Printing's game                                                       | selects the rule scope                                                                                                                                |
| Condition, Language      | the SKU key                                                               | multipliers                                                                                                                                           |
| Pricing Attributes       | the Printing's attribute values in the Mirror (rarity, finish, …)         | matched per Game System; shop-keepr matches, never interprets ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8))                             |
| on-hand (Buy only)       | `sku.on_hand` from the ledger, **before** this transaction; Holds ignored | Stock Band key ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48))                                                                          |
| line quantity (Buy only) | copies of the SKU on this line; `1` for the stored column                 | Quantity Band key ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48))                                                                       |

#### Steps (closed set)

Every step except `round` and `floor` is **a multiplier `k` and a signed flat amount `f`**, applied together as `p = round(p × k) + f`, integer minor units after each step. One signed flat field, never add/take-off pairs ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42), [ADR 0004](adr/0004-configurable-pricing-pipeline.md)).

| Step id                                            | Side     | What it applies                                              | Keyed on                                                                       |
| -------------------------------------------------- | -------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `fx`                                               | both     | `p = round(market × fx_rate)`                                | — (always first, locked)                                                       |
| `condition`                                        | both     | `k, f` for the SKU's Condition                               | Condition (`NM` reference)                                                     |
| `language`                                         | both     | `k, f` for the SKU's Language; a tag with no entry = `×1 +0` | Language                                                                       |
| `percentage`                                       | both     | `k = pct / 100, f` of the matching **Value Band**            | **converted Market Price** (output of `fx`), never the running total           |
| `stock`                                            | Buy only | `k, f` of the matching **Stock Band**                        | on-hand before the transaction                                                 |
| `quantity`                                         | Buy only | `k, f` of the matching **Quantity Band**                     | line quantity                                                                  |
| `attribute rows` (id `modifiers` in the prototype) | both     | for **every** matching attribute row, in turn: `k, f`        | Pricing Attribute value(s) of the Printing                                     |
| `round`                                            | both     | to `increment`, in `direction`                               | side's rounding setting                                                        |
| `floor`                                            | both     | `p = max(p, highest applicable floor)`                       | side's scope Floor (Sell Floor / Buy **Bulk Price**) and matching rows' floors |

Sources: [#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48), [#42](https://github.com/KeeprDigital/shop-keepr/issues/42), [ADR 0004](adr/0004-configurable-pricing-pipeline.md).

**Band lookup.** Bands are ascending by `from` (inclusive lower bound); the matching band is the highest `from ≤ key`; if none matches, the first band. Value Band `from` is in store-currency minor units; Stock and Quantity Band `from` are copy counts (prototype evaluator, [#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**Default calculation order** (per side, configurable per rule set, hidden from the MVP page):

- Sell: `fx → condition → language → percentage → attribute rows → round → floor`
- Buy: `fx → condition → language → percentage → stock → quantity → attribute rows → round → floor` ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48))

**Invariants (enforced, not configurable):** `fx` first; Value Band lookup before `percentage`; bands key on converted Market Price, never the running total. **Configurable but the trap:** `round` before `floor` by default; reversed, a 50p floor rounds to 40p ([ADR 0004](adr/0004-configurable-pricing-pipeline.md)).

**Multi-row.** Two attribute rows matching one card (rare _and_ foil) each apply their `k, f`; their floors do not stack, **the highest floor wins**, and the scope Floor (Bulk Price on Buy) is one of the candidates ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

**Flat placement.** A flat on an early step is scaled by every multiplier after it. An unscaled flat belongs on the last multiplying step: Value Band on Sell, Quantity Band on Buy. The "try a price" calculator is where this is seen ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**No "not buying" outcome.** The store never refuses a card by rule: a band wanting to stop buying sets `k = 0` and the Bulk Price answers ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

**Sell side has no stock or quantity step**, deliberately: a shelf price that moves when a copy sells is the instability ADR 0003 refuses ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

#### Resolution order

Resolved **per setting, independently**: attribute row → Game System rules → Store defaults. A game with no rules is tradeable; a game setting a rare row does not restate its condition multipliers. Rejected: all-or-nothing rule sets per Game System ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [ADR 0004](adr/0004-configurable-pricing-pipeline.md)). Attribute rows have no Store-default scope: Pricing Attributes belong to a Game System ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)). Tender settings are Store-only, no per-game override ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).

### Store settings

All store-scoped, seeded, editable in the MVP. Scope = `store` (defaults) or one Game System; side = `sell` | `buy`. Value shapes below are the prototype's and are the fixed content per setting; the physical table layout is not fixed by any ticket (**Open**). Condition vocabulary is **not** a setting (fixed enum) ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).

| Setting key                 | Sides                              | Scopes      | Value shape                                                                                                                                                       | Seed                                                                                                  |
| --------------------------- | ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `valueBands` (Percentage)   | sell, buy                          | store, game | `[{from: minor units of converted Market Price, pct: integer %, f: signed minor units}]`                                                                          | Open: not fixed (prototype demo: Sell 100/105/110 % at £0/£10/£50; Buy 50/60/65 % at £0/£5/£20)       |
| `condition`                 | sell, buy                          | store, game | `{NM,LP,MP,HP,DMG: {k, f}}`                                                                                                                                       | Open: not fixed (prototype demo Sell `1/.85/.7/.5/.3`, Buy `1/.8/.6/.4/.2`, `f = 0`)                  |
| `language`                  | sell, buy                          | store, game | `{<BCP 47 tag>: {k, f}}` for the store's list                                                                                                                     | Open: not fixed (prototype demo `en 1`, others `.7–.9`)                                               |
| `stockBands` (Stock Bands)  | buy                                | store, game | `[{from: on-hand count, k, f}]`                                                                                                                                   | one neutral band `[{from:0, k:1, f:0}]` ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)) |
| `qtyBands` (Quantity Bands) | buy                                | store, game | `[{from: line qty, k, f}]`                                                                                                                                        | one neutral band `[{from:1, k:1, f:0}]` ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)) |
| `rows` (Attributes)         | both in one row                    | game only   | `[{attr, value, sell:{k, f, floor or null}, buy:{k, f, floor or null}}]`; a row exists on both sides; clearing one side removes it only when the other is neutral | none ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42))                                    |
| `floor`                     | sell (Floor), buy (**Bulk Price**) | store, game | integer minor units                                                                                                                                               | Open: not fixed (prototype demo Sell 25p, Buy 5p)                                                     |
| `rounding`                  | sell, buy                          | store, game | `{inc: minor units, dir: up / down / nearest}`                                                                                                                    | Open: not fixed (prototype demo Sell 10p up, Buy 5p down)                                             |
| `tender`                    | buy                                | store only  | `{def: cash / credit, mod: integer %}` — Default Tender + Tender Modifier                                                                                         | `cash`, `0` ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43))                             |
| `steps` (Calculation order) | sell, buy                          | store, game | ordered array of step ids                                                                                                                                         | defaults above; not on the MVP page ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42))     |

General (non-pipeline) settings, on Settings › General ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26)):

| Setting                        | Seed                             | Source                                                      |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------- |
| Trading currency               | one per Store                    | [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)   |
| Default Language               | store's region                   | [ADR 0002](adr/0002-language-on-sku.md)                     |
| Hold TTL                       | — (kiosk section)                | [#10](https://github.com/KeeprDigital/shop-keepr/issues/10) |
| FX rate (stepped) + manual set | fetched                          | [ADR 0003](adr/0003-stepped-exchange-rate.md)               |
| FX step threshold              | **2 %**                          | [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)   |
| Pin drift threshold            | **25 %**                         | [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)   |
| Pin age threshold              | **90 days**                      | [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)   |
| Market Price pull interval     | 24 h, **not surfaced** in MVP UI | [#14](https://github.com/KeeprDigital/shop-keepr/issues/14) |

"Who can change a setting" is not a pricing question: one shared login ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)). No bound on Tender Modifier; 200 % is honoured ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).

### Stored SKU prices and recompute

**Columns on the SKU row.** Sell Price and Buy Price are **stored columns**, so they sort and filter; computed-on-read was rejected for that reason ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)). Per side: the price, `price_source` (`rule | pinned`), pinned-by and pinned-at. Plus `priced_at` (last evaluation). Exact column names beyond `price_source` and `priced_at` are not fixed (**Open**) ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).

**Stored Buy Price = pipeline at quantity 1 under current on-hand** ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

**A Printing with no SKU row** is priced **on read** through the same evaluator, at on-hand 0; SKU rows are never materialised speculatively. The row is created at the first Buy (or a pin), which is when a never-held card gets a stored price ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

**When prices are recomputed:**

| Trigger                                         | Mechanism                            | Scope                                                                              |
| ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Rule / setting edit (any except Tender)         | queue-backed sweep                   | SKUs of affected games, `on_hand > 0 OR pinned`                                    |
| FX step                                         | queue-backed sweep                   | full store, `on_hand > 0 OR pinned`                                                |
| Market Price delta                              | queue-backed sweep, watermark-driven | `sku.priced_at < printing.market_price_updated_at`, within `on_hand > 0 OR pinned` |
| Ledger append for a SKU (Buy, Sell, Adjustment) | **inline, in the request**, one row  | that SKU's **Buy Price** only (on-hand moved)                                      |
| Tender settings change                          | none                                 | acts on a total, not a price                                                       |

Sources: [#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#48](https://github.com/KeeprDigital/shop-keepr/issues/48), [#42](https://github.com/KeeprDigital/shop-keepr/issues/42).

**The sweep.** Queue-backed, chunked by SKU-id cursor, idempotent, resumable, **one job per store**, never request-time; the store keeps trading while it runs and a mid-flight price is the previous price. Progress visible (sidebar footer on Settings; "Repricing Magic: 1,240/8,000" on System). Pinned rows skipped. Zero-stock unpinned SKUs are never swept: nothing displays or sorts them, and they are recomputed on re-entry. Rows are never deleted. A missed reprice self-heals on the next sweep (watermark stays behind). Untested at scale; first thing to measure ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).

**Sweep estimate on Save.** SKU count of: the edited game, for a game-scope change; every game that _inherits_ that setting, for a Store-default change. Confirm dialog ("This reprices ~N SKUs (games). The store keeps trading while it runs") **only above ~1,000 SKUs**; below, save silently with progress in the sidebar footer ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**No rule versioning, no price provenance.** The price is the price; after a rule change it can only be recomputed under current rules. What a customer paid is snapshotted on the Transaction line (list + transacted) ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [ADR 0004](adr/0004-configurable-pricing-pipeline.md)).

**Freshness.** No live per-card refresh before a Buy commits: a stored price is as fresh as the last Market Price pull, which is the source's own cadence ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)). Sell Price is snapshotted onto a Basket line at add ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [ADR 0003](adr/0003-stepped-exchange-rate.md)).

### Market Price storage and null handling

Stored on the Mirror's Printing record: `market_price` (current rate, Catalogue currency) and `market_price_updated_at`, written only when the value differs, so `updated_at` means _moved_. No price history read through in the MVP (a Buy-counter trend indicator is later UI work). A null rate from the Catalogue **never overwrites a good value**: last known rate served with its `updated_at` visible, logged loudly (`projection_drift` precedent). Rejected: failing the sync; blocking the SKU from sale. The rules need no no-rate branch beyond staff-set fallback (a pin) ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)). Market Price is staff-visible, **never customer-visible** ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).

### FX: the stepped rate

Conversion happens in shop-keepr, first step of the pipeline. The rate is **fetched on a schedule but held as a discrete, versioned value**: the stored rate is replaced only when the fetched rate has moved past the **step threshold (seed 2 %)**; between steps it does not move at all; a **manual set** is available. A step is a **deliberate, logged event** that triggers a full reprice sweep. Fetch outage fallback: the stored rate. Rejected: convert at source (fires Catalogue change detection for every Printing on every tick, pushes a store fact into a store-agnostic service); live rate (retail stability, explicability, second live dependency, precision below rounding); purely manual (rots). Revisit if: multiple trading currencies, a volatile pair, thin margins on high-value singles ([ADR 0003](adr/0003-stepped-exchange-rate.md), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)). System page shows stepped rate, fetched rate, **Set manually** ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26)). The Catalogue's price currency is not named in any ticket; the prototype assumed USD → GBP.

### Pinned Price

- **Grain: per SKU, Sell and Buy independently.** Rejected: Printing-level pins (would have to fan out through multipliers, which is the rule again) ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- **Columns:** `price_source = rule | pinned` per side, plus who and when. `price_source` exists for one reason: the sweep skips pinned rows. `when` is load-bearing (age alert) ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- **Sticky, never auto-reverted**; stands until cleared by a person. A SKU row may exist at **on-hand 0** to carry a pin (and is then in Inventory and in the sweep scope) ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- **A Pinned Buy Price is final**: Stock and Quantity Bands do not apply; the line price equals the pin at any quantity. A different number for a pile is the per-line override, which never pins ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).
- **Alerts:** a pin is flagged stale on **market drift** past the drift threshold (25 %) _or_ **age** past the age threshold (90 days). **An alert never changes the price** ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- **Screen:** `/pinned`, all pins, stale rows flagged; per-row actions **Re-pin** (new value), **Unpin**, **Keep** (resets the age clock only). Nav badge = stale count; no banner, no toast ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).
- **Marking:** pin icon beside any pinned price wherever a price appears (Lookup, Transaction lines, Inventory, sessions, lists); tooltip: who, when, market now. Pin/Unpin from the SKU row (modal: side, value; "…" submenu in the Lookup card). **Never on the kiosk** ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46)).
- Pinning is the escape hatch for rules the fold cannot express, and the base the later Buylist builds on ([ADR 0004](adr/0004-configurable-pricing-pipeline.md), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).

### Buy-line evaluation

A Buy line (counter, Large Buy, Customer List → Large Buy) runs the evaluator with the **line's actual quantity** and the **on-hand before the buy**. **One price per line**: six copies over the counter with two held are all priced from "we hold 2"; prices never step inside a line. Rejected: stepping within a line (allocation problem with no right answer); quantity selecting the percentage like Value Bands (two band dimensions choosing one percentage has no clean rule); available (on-hand minus Holds) as the stock key (kiosk baskets would move the Buy Price) ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)).

**The line records**, beside list and transacted price ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)): the **unit price at quantity 1** and the **quantity multiplier applied**, so a gap seen at audit says what it was. The stock multiplier is inside the stored unit price at that moment and is not separately recorded ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48)). Column names not fixed (**Open**).

A line starts at the SKU's Buy Price (rule-computed on read when no SKU row exists, invisibly). Per-line override edits this line only, never the SKU price, never pins ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)). Market Price is visible on the line (staff surface) ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11)).

### Transaction-level factors (as they touch pricing)

Every Buy Price, on every line and screen, is quoted in the store's **Default Tender**. The other Tender is **never a price on a line**, only a factor on the Buy total. Header columns and the Trade split are the ledger section's ([ADR 0010](adr/0010-tender-and-total-factors-on-the-total.md)).

- **Tender factor** (Buy only): Default `cash` → credit pays `total × (1 + mod %)`; Default `credit` → cash pays `total × (1 − mod %)`; factor 1 when the Buy's tender equals the default. Store-only setting: a Buy may hold several games, and a per-game factor could only apply per line. Rejected: two Buy Prices per SKU, one per Tender (doubles every stored price and sweep) ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [ADR 0010](adr/0010-tender-and-total-factors-on-the-total.md)).
- **Total Percentage**: signed integer percent, `−100..+100`, typed per Transaction by staff, **no setting behind it**, starts at 0. Applied to the whole total, never spread to lines. On Buy (counter, Large Buy, Customer List) and on staff-closed Sells (counter, Customer List); null on kiosk Sells. "Always 10 % off" is a Pricing Rule, not a Total Percentage ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44)).
- **`total = round(Σ transacted × tender factor × (1 + total_pct))`**, rounded **once, last**, by the **side's pipeline rounding rule** (increment + direction) so a cash payout is tidy. A Sell has no Tender and no tender factor ([#44](https://github.com/KeeprDigital/shop-keepr/issues/44), [ADR 0010](adr/0010-tender-and-total-factors-on-the-total.md)).
- A Tender settings change **never sweeps** ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

### The pricing settings page

Route `/settings`, tab **Pricing** (tabs: General, Game Systems, Kiosks, Pricing) ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26)). Layout is **Setting-first**: pick the setting, then see it across every scope. Rejected: Stacked (#26's scope-first layout; changing one buy percentage walks past the whole pipeline; survives only as the per-scope editor); Sheet (settings × scopes matrix; 4 clicks vs 2 for the reference task) ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**Left: settings list**, grouped Sell and Buy, with a find box; a dirty dot on any entry with unsaved edits.

| Side | Group                 | Setting keys                                                             |
| ---- | --------------------- | ------------------------------------------------------------------------ |
| Sell | Percentage            | `valueBands`                                                             |
| Sell | Condition & Language  | `condition`, `language`                                                  |
| Sell | Attributes            | `rows`                                                                   |
| Sell | Floor & Rounding      | `floor`, `rounding`                                                      |
| Sell | Calculation order     | `steps` (hidden in MVP)                                                  |
| Buy  | Percentage            | `valueBands`                                                             |
| Buy  | Condition & Language  | `condition`, `language`                                                  |
| Buy  | Stock & Quantity      | `stockBands` (_by copies we hold_), `qtyBands` (_by copies in this buy_) |
| Buy  | Attributes            | `rows`                                                                   |
| Buy  | Bulk Price & Rounding | `floor` (labelled Bulk Price), `rounding`                                |
| Buy  | Tender                | `tender` (Default Tender, Tender Modifier), outside the pipeline steps   |
| Buy  | Calculation order     | `steps` (hidden in MVP)                                                  |

([#42](https://github.com/KeeprDigital/shop-keepr/issues/42))

**Right: the chosen setting across every scope**: Store defaults first, then each Game System, as **columns that wrap by available width** (five across on a desk, two or three on a laptop, one on a phone). Rejected: tabs (waste width, hide inheritance); stacked list. Build note: collapsing sidebar at narrow widths ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**Inheritance per setting, not per group.** A game column shows the inherited value greyed ("Inherited from Store defaults") with **Override**; overridden shows the editor with a "<game> override" badge and **Revert**. Inside a folded group each key inherits or overrides independently; the column header reads "sets some of its own". Typing into an inherited field overrides it (recommended, accepted, untested). Tender shows Store defaults only. Attributes: Game Systems as scopes, Store defaults a greyed "no default here" column; per row: attribute, value, and per side `k`, `f`, Floor ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**Save per setting group.** Dirty count and sweep estimate shown; confirm "reprices ~N SKUs (games)" only above ~1,000 SKUs, else silent with progress in the sidebar footer; reprice progress also in the sidebar footer ("Repricing Magic …"). Tender never sweeps. Banner slot: staleness/drift wins over reprice-in-progress ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26)).

**"Try a price" dock** at the foot of the page, closed by default: a one-line bar always showing the sample card and its Sell and Buy result; opens upward to the inputs (Game System, Condition, Language, Market Price, Pricing Attribute values, on-hand, quantity) and the two step traces, with the selected setting's step highlighted and the **biggest cut named**. On the Tender group the dock says Tender acts on a total, no step to show. Rejected: a side rail (horizontal space). Later tweak: sample card follows the selected setting (Stock & Quantity pre-sets "we hold 5") ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

**Calculation order** stays configurable in the evaluator and **is hidden from the MVP page**; a reorder is a support request ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).

**Keybindings:** none fixed. The prototype's `←`/`→` switched layout variants and `Esc` closed the save confirm; only `Esc` carries a plausible meaning for the build ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

Prototype: branch `prototype/pricing-settings`, `prototype/pricing-settings/index.html`, `?variant=C` is the chosen layout; the pure pricing module (settings model, resolution, evaluator, sweep estimate) is DOM-free and is the reference evaluator ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).

## 7. Auth, Holds and realtime, and the kiosk

### Auth

**Better Auth for both identities: one library, two credential types, two API surfaces.** Both credentials are rows in the same D1 database, revoked the same way, provisioned from the staff UI. ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3))

| Surface                           | Credential                                                                       | Delivery                                                                                                                                                            | Revocation                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Staff UI (`/`, login at `/login`) | Better Auth email + password; one shared store login = one row in `user`         | DB-backed session cookie; `cookieCache` **off**                                                                                                                     | Delete the `session` row; immediate                            |
| Kiosk (`/kiosk/*`)                | Better Auth API Key plugin (`@better-auth/api-key`); one key per enrolled device | `HttpOnly; Secure; SameSite=Lax; Path=/api/kiosk` device cookie, read server-side via `customAPIKeyGetter`; never in a response body, never readable by page script | Delete / disable the key; "Revoke" on the enrolled-device list |

([#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

**Kiosk enrolment.** Staff, logged in on the kiosk device, open Settings › Kiosks › "Enrol this device". Server mints an API key with `permissions: { basket: ["create"], inventory: ["read"] }`, `metadata: { deviceName, enrolledBy, enrolledAt }`, long `expiresIn`; a **single-use, short-TTL enrolment code** is shown to staff and typed into the kiosk once; the kiosk posts the code and the server answers with the `Set-Cookie`. Re-enrolling a device issues a new key and revokes the old. Keys stored **hashed**. Settings › Kiosks lists enrolled devices with Revoke. An unenrolled device at `/kiosk` shows "not enrolled". ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

Rejected: a long-lived Better Auth _session_ for the kiosk (session lifetime is global; API keys carry per-key expiry, permissions, rate limit, usage cap). Rejected: any token in `localStorage` / JS (public touchscreen, unlimited attacker time). ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3))

**Route protection.**

| Rule                               | Detail                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/kiosk/**`                    | Accepts **only** a kiosk key. A staff session is rejected, loudly.                                                                                                                                                                                                                                         |
| `/api/staff/**`                    | Accepts **only** a staff session. A kiosk key never satisfies a staff guard, even in dev.                                                                                                                                                                                                                  |
| Deny by default                    | A route not placed in a surface is unreachable.                                                                                                                                                                                                                                                            |
| Scope at the schema, not the guard | Kiosk responses use their own Zod response schemas under `shared/contracts/kiosk/` with no slot for Market Price, Buy Price or ledger data; auth-gated field stripping rejected. Separate handlers and schemas over shared services; directories not Nuxt layers; cross-surface imports blocked by eslint. |
| Kiosk writes                       | Exactly: create Basket; add / remove / change a line on **its own** Basket; submit.                                                                                                                                                                                                                        |
| Rate limit                         | Plugin `rateLimitEnabled` / `rateLimitTimeWindow` / `rateLimitMax` on the kiosk key; Basket creation especially (a leaked key must not drain available quantity). Values: not fixed.                                                                                                                       |

`/api/kiosk` was `/api/admin` in #3; #9 names the staff surface `/api/staff`, later wins. ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9))

**Tables and library constraints.**

| Item                 | Decision                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth tables          | Better Auth's own `user`, `session`, `account`, `verification`, `apikey` in the **same D1 database** as the app schema, via the built-in **Kysely/D1 path** (`database: env.DB`). **Not** the Drizzle adapter (better-auth#10816: raw `Date` reaches D1, no escape hatch). Drizzle owns the application schema only. |
| Migrations           | Programmatic: `getMigrations(auth.options)` → `runMigrations()` (the CLI cannot reach D1).                                                                                                                                                                                                                           |
| Timestamps           | #2's epoch-ms rule does not extend to auth tables; the Kysely/D1 adapter serialises internally.                                                                                                                                                                                                                      |
| Session config       | DB-backed, `cookieCache` off. Better Auth defaults otherwise (7 d `expiresIn`, 1 d `updateAge`); not overridden by any ticket.                                                                                                                                                                                       |
| Handler              | `server/api/auth/[...all].ts` → `auth.handler(toWebRequest(event))`; client `better-auth/vue`, `authClient.useSession(useFetch)`.                                                                                                                                                                                    |
| Bindings             | `event.context.cloudflare.env` inside handlers (Nitro 2); `import { env } from "cloudflare:workers"` for the module-scope `auth` singleton.                                                                                                                                                                          |
| Secret               | `BETTER_AUTH_SECRET` via `wrangler secret put`, never in `wrangler.jsonc`.                                                                                                                                                                                                                                           |
| Plan                 | **Workers Paid** is a hard requirement (Free's 10 ms CPU cannot fit scrypt).                                                                                                                                                                                                                                         |
| Versions             | `better-auth` ≥ 1.7.3; **CI asserts resolved `@better-auth/utils` ≥ 0.4.1** (below it, Workers silently falls to pure-JS scrypt, ~5 s per sign-in, no error).                                                                                                                                                        |
| Isolate poisoning    | **Eagerly init `auth.$context` at module scope** from the first commit (better-auth#10315: an aborted request otherwise hangs every later auth call forever; kiosk search-as-you-type is the trigger).                                                                                                               |
| Hashing              | scrypt (default). argon2 unavailable on Workers; PBKDF2 capped at 100k iterations.                                                                                                                                                                                                                                   |
| `compatibility_date` | ≥ `2026-08-04`, or `nodejs_compat`; Nitro 2 also writes `no_nodejs_compat_v2`.                                                                                                                                                                                                                                       |
| KV                   | Disqualified for sessions (no read-your-writes; revocation lag). Sessions stay in D1.                                                                                                                                                                                                                                |
| Read replication     | If ever enabled, auth tables stay off it (the library will not route through `withSession()`). Not MVP.                                                                                                                                                                                                              |

([#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [research](research/2026-09-07-auth-on-cloudflare-workers.md))

**Path to per-staff users.** Create `user` rows (Admin plugin) → `revokeSessions()` on the shared account → delete it. Organization and Admin plugins drop in later; no vendor migration. Audit under the shared login is `created_at`, `surface`, `session_id`, nullable `staff_user_id` on every ledger entry, backfilled at the split (#3's `actorUserId` became #7's `staff_user_id`). Cloudflare Access may be layered on staff paths **at per-staff**, additively; never the kiosk. ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [#7](https://github.com/KeeprDigital/shop-keepr/issues/7))

Rejected: Cloudflare Access as primary (cannot cover the kiosk; Bypass on kiosk paths disables all Access controls and logging; the app must validate the Access JWT anyway). Clerk (JWT sessions, revocation not immediate; user list off-platform). WorkOS (M2M is `client_credentials`, a client secret on a public touchscreen). Stateless signed-cookie sessions (no revocation). ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3))

### Realtime and Holds

**Holds are D1 rows. Reservation is one conditional statement. Transport is polling behind an interface. Expiry is lazy on read, with a Cron Trigger sweeper. No Durable Object in the MVP.** ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4))

#### The Hold row and the clock

A `hold` row: `id`, `basket_id`, the SKU key, `quantity`. **No `expires_at` on the Hold**: the Basket carries one `expires_at` and every Hold in it inherits that instant. Holds leave singly only when a line is removed (customer while shopping, staff at the pick); they are never released alone by time. Every non-terminal Basket has a clock, including `open` ones the idle reset will cancel first, so the availability query and the sweeper never inspect Basket state. ([ADR 0006](adr/0006-basket-owns-the-hold-clock.md), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10))

Rejected: a clock per Hold (a Basket lapses one line at a time mid-shop); both clocks (two sources of truth). ([ADR 0006](adr/0006-basket-owns-the-hold-clock.md))

**Availability is one query, in one place**, never scattered across call sites:

```
available = on_hand − COALESCE(SUM(hold.quantity) WHERE basket.expires_at > now, 0)
```

Predicate is strict `>`: a Basket expiring at exactly `now` is already expired, deliberately. ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [ADR 0006](adr/0006-basket-owns-the-hold-clock.md))

#### The reservation statement

Target form. The spike verified this statement with a per-Hold clock; ADR 0006 moved the clock onto the Basket, which changes only the subquery's join:

```sql
INSERT INTO hold (id, store_id, sku_id, basket_id, quantity)
SELECT ?id, ?store, ?sku, ?basket, ?qty
WHERE (SELECT on_hand FROM sku WHERE id = ?sku)
    - COALESCE((SELECT SUM(h.quantity) FROM hold h JOIN basket b ON b.id = h.basket_id
                WHERE h.sku_id = ?sku AND b.expires_at > ?now), 0) >= ?qty;
```

One statement, no JS turn inside it ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [ADR 0006](adr/0006-basket-owns-the-hold-clock.md)).

| Fact                                               | Value                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Atomicity                                          | One SQLite statement; no `BEGIN TRANSACTION`, no interactive transaction. Verified locally and **against real D1 from a deployed Worker**: 16,250 attempts, zero oversell, concurrency 2/10/50/200, 25-way `batch()`, 25-way HTTP, partial and mixed quantities; negative control (JS read-then-write) oversold 25/25 in 50/50 iterations. |
| Success signal                                     | `meta.changes` = 1 won, 0 lost. No error thrown.                                                                                                                                                                                                                                                                                           |
| Ambiguity                                          | `changes = 0` for an **unknown SKU** too; the kiosk re-reads availability to choose its message.                                                                                                                                                                                                                                           |
| Cost                                               | ~34 ms wall per reserve (0.26 ms in D1); D1 serialises ~400 statements/s per database.                                                                                                                                                                                                                                                     |
| **`.batch()` gives atomicity, not conditionality** | A later statement runs even when the conditional insert inserted nothing (observed: `hold changes=0`, `on_hand` decremented anyway). **Every dependent statement carries its condition in SQL**, e.g. `... AND EXISTS (SELECT 1 FROM hold WHERE basket_id = ?2 AND sku_id = ?1)`. A failing later statement rolls the whole batch back.    |
| Idempotency                                        | A timed-out `run()` may have committed; a client retry then creates a second Hold. Spike recommends `UNIQUE(basket_id, sku_id)` on `hold`. Not a ticket decision; build note.                                                                                                                                                              |
| Duplicate-add                                      | Two reservations for the same SKU in one batch yield `[1, 0]`; statements are sequential in the transaction.                                                                                                                                                                                                                               |

([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17), [spike](../spike/d1-hold-atomicity/README.md))

Rejected: Holds in Durable Object SQLite (the "needs interactive transactions" premise was disproved); Turso interactive transactions (960 `SQLITE_BUSY` at 25 racers). ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#18](https://github.com/KeeprDigital/shop-keepr/issues/18))

#### Transport: polling, upgradeable by design

Staff must notice a new Basket within a few seconds. A **~3 s poll** on an indexed query from a handful of screens meets that inside the Workers Paid allowance. Requirements, not suggestions: ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4))

| Requirement                  | Detail                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One interface                | Everything subscribes through `subscribeToBasketQueue(storeId, onEvent)`-shaped code. No component calls `setInterval`; no polling detail in UI code.                                                                                                  |
| Event shape now              | `basket created` / `changed` / `fulfilled` / `expired`. The poller **synthesises** these; a push implementation emits the same and nothing downstream changes. The shape is a contract beside the staff queue operations in `shared/contracts/staff/`. |
| Poll by cursor, not snapshot | Monotonic sequence or `updated_at` watermark: "what changed since X". A WebSocket or Ably stream later replays from the same cursor; reconnect semantics already solved.                                                                               |
| One availability query       | As above.                                                                                                                                                                                                                                              |

([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9))

**Upgrade triggers** (revisit when any holds): more than a handful of concurrent screens; a sub-second latency requirement; multi-store; the kiosk needing to react live to stock changes rather than on its own poll. **Likely successor**: a Durable Object via Nitro's `cloudflare-durable` preset (its alarm replaces the cron; no second vendor). Build gotchas recorded: Nitro does not generate the DO binding or migration into wrangler config; use `new_sqlite_classes`, never `new_classes`; the preset hardcodes one instance named `server`; sockets die on deploy so clients reconnect and re-snapshot; version the message envelope. **Ably** stays the documented fallback, viable if reconnect / history / presence ergonomics outweigh avoiding a vendor; its free tier fits many times over. **Plain SSE is eliminated**, not deferred: Workers are isolate-local, so SSE needs a DO or Ably behind it regardless. ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [research](research/0004-realtime-basket-delivery-and-hold-expiry.md))

Kiosk poll interval: not fixed by any ticket.

#### Expiry: lazy on read, cron to tidy

`basket.expires_at` filtering on read is the correctness invariant; **correctness never depends on a timer firing**. A **Cloudflare Cron Trigger every minute** (1-minute granularity, ample for a TTL in tens of minutes) deletes Holds whose Basket has expired and is the hygiene pass that marks `open` / `submitted` Baskets `expired`. **The sweeper GCs Hold rows only**; Basket rows are kept forever. If a DO is later adopted its alarm may replace the cron; the lazy invariant stays. ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10))

### Basket lifecycle

**A Basket is private to the kiosk until the customer submits it; the Basket owns one expiry clock every Hold inherits; staff Complete it in one action that requires a POS Reference; an expired Basket is revivable by staff as a re-reservation.** ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10))

#### States and transitions

Five states: `open`, `submitted`, `fulfilled`, `cancelled`, `expired`. Internal id an opaque ULID. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10))

| From                                         | To          | Trigger                                                        | Holds / clock                                                                      |
| -------------------------------------------- | ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| —                                            | `open`      | First add at the kiosk                                         | Hold created per line; clock = `basket.expires_at` = now + TTL                     |
| `open`                                       | `open`      | Add / remove / qty change                                      | Clock reset to now + TTL                                                           |
| `open`                                       | `submitted` | Customer submits                                               | Clock reset once; **Basket Number issued**                                         |
| `open`                                       | `cancelled` | Customer clears, or kiosk idle reset                           | Released immediately                                                               |
| `submitted`                                  | `fulfilled` | Staff **Complete**: POS Reference required, ≥ 1 line remaining | Sell written for remaining lines at snapshot prices; released                      |
| `submitted`                                  | `submitted` | Staff removes a line with a reason (`not-found` default)       | That line's Hold released                                                          |
| `submitted`                                  | `cancelled` | Staff cancel; no reason required                               | Released                                                                           |
| `open` / `submitted`                         | `expired`   | `expires_at` passes (lazy on read; cron GC)                    | Released                                                                           |
| `expired`                                    | `submitted` | Staff **Revive** within 24 h                                   | Re-reserved per line under a fresh clock; lines that fail are dropped; number kept |
| `fulfilled` / `cancelled` / `expired` > 24 h | —           | Terminal; kept forever                                         | —                                                                                  |

`open → expired` is unreachable in practice (idle reset ≪ TTL) but kept so "every non-terminal Basket has a clock" holds without a special case. Rejected: `picking` (needs per-staff identity; add with per-staff users); `abandoned` (is `expired` or `cancelled` depending on which clock won). ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [ADR 0006](adr/0006-basket-owns-the-hold-clock.md))

#### Submission and Basket Number

**Explicit.** Only `submitted` Baskets appear on the staff queue; continuous delivery rejected (fills the queue with half-built Baskets). Reservation and submission are decoupled: Holds protect stock from the first add, submission signals intent. A customer cannot edit after submitting (the kiosk has reset and identifies nobody); they start a new Basket and staff handle two numbers. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10))

| Basket Number | Value                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Format        | Random three-digit integer, `100–999`                                                                               |
| Uniqueness    | Per store among **live** Baskets: non-terminal, plus `expired` within the 24 h revival window                       |
| Collision     | Redraw                                                                                                              |
| Reuse         | Once a Basket leaves the live set                                                                                   |
| Lookup        | Display handle only; never a lookup key outside the live set. `Cmd+K` on the staff UI finds a live Basket by number |
| Revive        | Keeps its number                                                                                                    |

Rejected: sequential from 1 (tells every customer how busy the shop is). ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

#### TTL and expiry reset

| Setting            | Value                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hold TTL           | **20 min default, 5–120 min**, one store setting (Settings › General "Hold TTL")                                                                                               |
| Reset while `open` | On any customer action (add, remove, qty change)                                                                                                                               |
| Reset at submit    | Once more                                                                                                                                                                      |
| After submit       | Runs down. **No reset, no manual extension, MVP or ever**; if staff need longer they fulfil it                                                                                 |
| Customer countdown | **None.** Two copy mentions only: basket footer ("put aside while you shop") and the number screen ("put aside for N minutes")                                                 |
| Kiosk idle         | **60 s** no activity → "Still there?" overlay → **30 s** ring → Basket `cancelled`, Holds released immediately, home. The TTL therefore only ever fires on `submitted` Baskets |

([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28))

#### Prices on a Basket

Sell Price snapshots onto the Basket line at add and is **binding at fulfilment**; the same stored number appears in search, Basket and counter. Terminal Baskets are kept, never deleted: the snapshotted line prices are the only record of what a customer was quoted; revival and the shortfall worklist read them. ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10))

#### Staff Complete, shortfall and cancel

**Complete** is one action after the POS has taken the money: writes the Sell (ledger kind `sell`, `origin = kiosk`, `basket_id` on the header, one line per remaining Basket line at the snapshotted price), releases the Holds, moves the Basket to `fulfilled`. **POS Reference required**: opaque non-empty string, never validated against the POS, editable afterwards on the Transaction, not unique. A Basket with every line removed cannot be completed; cancel it. No Total Percentage on a kiosk Sell; a Sell records no Tender. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44))

**Shortfall / reasoned removal.** Any line that cannot be sold is removed from the `submitted` Basket with a reason recorded on the dropped line: `not-found` (default), `customer-declined`, `other`. The Sell covers what is left; partial fulfilment is normal. Correcting on-hand is a **separate** Adjustment, never forced here; the missing copy's Hold releases on removal, so it is re-offered at the kiosk until the Adjustment happens, and the reasoned removals are that process's worklist. If this bites, promote `not-found` to an automatic Adjustment additively. Selling through a kiosk Hold at the counter is allowed, bounded by on-hand, with a warning naming the Basket Number (the physical card wins). ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31))

**Staff cancel**: no reason. **Revive**: staff action on the Queue's Expired tab, within 24 h, re-runs the reservation per line under a fresh clock, drops lines that fail, keeps the number, lands the Basket in `submitted`. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

**Optional name**: captured on the kiosk confirm sheet, shown beside the number on the queue. No customer entity. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28))

#### Staff Queue page

`/queue`, master-detail: `submitted` Baskets left (number, name, line count, expiry countdown, age); selected Basket's lines right with per-line remove-with-reason and **Complete** (modal: POS Reference). **Expired** tab with Revive. New submission: toast + nav badge, no sound; Basket submissions never take the banner slot. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

### Kiosk screens

**Variant A: a hard gate per Game System, a per-Printing result grid with a customer-facing "Group versions" switch, a Printing page for Conditions and Add, a Basket slideover spanning games.** ([#28](https://github.com/KeeprDigital/shop-keepr/issues/28))

**Layout.** Own layout at `/kiosk/*`, device-cookie gated; no sidebar; large touch targets. Assumed hardware: landscape touchscreen ≥ 1080p, touch-only, on-screen keyboard. Unenrolled device: "not enrolled" screen. Printing images render from the Catalogue's host; the kiosk never calls the Catalogue API itself. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#15](https://github.com/KeeprDigital/shop-keepr/issues/15), [#5](https://github.com/KeeprDigital/shop-keepr/issues/5))

| Screen                         | Route                       | Content                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attract** (Game System gate) | `/kiosk`                    | Store name; heading "What do you play?"; one big tile per **enabled** Game System (Settings › Game Systems, `store_game_system.enabled`, default all on). **Skipped when one game is enabled.** Picking a game is a hard gate: a search only ever runs in that game.                                                                                                                                       |
| **Search**                     | `/kiosk/search`             | Bar: current game with a _change_ button (back to Attract), search box, persistent Basket button. Second row: **Filter** button (facets in a slideover, active-filter chips), **"Group versions"** switch, **"In stock only"** toggle. Results grid.                                                                                                                                                       |
| **Printing**                   | `/kiosk/printing/:id`       | Big image; name, set / collector number, finish; **Condition rows in full words** ("Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged") each with Sell Price and **Add**; a **Language row only when a non-default-language copy is held**; **other-versions strip** (other Printings of the same Card). A route, not a modal: modals on a keyboardless touchscreen get stuck. |
| **Basket**                     | slideover, no route         | From the persistent Basket button. Lines with qty − / +, per-line total; Total; **"Send to the counter"**; footer note. **One Basket spans Game Systems**: changing game keeps it; the Basket button counting up across the switch is the tell.                                                                                                                                                            |
| **Submit**                     | confirm sheet, no route     | Lines, Total, optional name field, Submit.                                                                                                                                                                                                                                                                                                                                                                 |
| **Number**                     | full-screen; path not fixed | "Your number is 417 — go to the counter" (name appended when captured); "put aside for N minutes" (N = the TTL setting); **Done**; **auto-return after 30 s** to Attract.                                                                                                                                                                                                                                  |
| **Idle overlay**               | overlay                     | After **60 s** without activity: "Still there?" with a **30 s** ring countdown and a tap-to-stay button; on expiry the Basket cancels and the kiosk returns to Attract.                                                                                                                                                                                                                                    |

([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#22](https://github.com/KeeprDigital/shop-keepr/issues/22))

#### Search behaviour

| Rule                   | Detail                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope                  | Game-scoped, always. **No cross-game search and no cross-game miss check**.                                                                                                                                                                                        |
| Engine                 | The one shared search: the #24 five-tier cascade over the Mirror in D1, joined to stock, facets per Game System from the per-game search table. Stock and availability **exact, not advisory**, computed in the same query.                                        |
| Results                | **Per Printing** (image, set, price). **"Group versions" switch, default on**: grouped shows one entry per Card that opens to its Printings; off is the flat per-Printing grid. The switch lives for one customer: idle reset and Done clear it. No staff setting. |
| Price on a result card | A **range across the Conditions held**: "£2.40 – £4.00". A single held Condition shows a single price, **no "from"**. Rejected: NM-when-held; lowest-with-"from"; no price.                                                                                        |
| In-stock filter        | "In stock only" **default on**. Off shows Printings with no stock as "Not in stock".                                                                                                                                                                               |
| Facets                 | Set and rarity everywhere; Magic colour identity, card type, finish; Pokémon card kind, energy type, stage, variant; One Piece colour, card type; Riftbound domain, card type. Slideover from Filter; active-filter chips on the bar.                              |
| Near miss              | **Silent.** A tier-5 token correction shows its results with nothing on screen. Tiers 1–4 are invisible by nature. Rejected: banner; did-you-mean.                                                                                                                 |
| Empty state            | "Nothing found in Magic. Check the spelling, or pick another game." (game name substituted). A hint, not a query.                                                                                                                                                  |
| Withdrawn Printings    | Hidden from the kiosk (staff still see and sell them).                                                                                                                                                                                                             |
| Pagination             | Not built in the prototype; not fixed.                                                                                                                                                                                                                             |

([#28](https://github.com/KeeprDigital/shop-keepr/issues/28), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24), [#15](https://github.com/KeeprDigital/shop-keepr/issues/15), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#6](https://github.com/KeeprDigital/shop-keepr/issues/6))

#### Add, race and "just gone"

Add is only on the Printing page; a chip-sized target mis-adds. Add runs the reservation statement; `changes = 1` adds the line and resets the clock. On `changes = 0` the kiosk re-reads availability: if the SKU has just gone, the Condition row shows **"just gone"** and the page offers the other Conditions and other versions in stock; **no waitlist**. A line already in the Basket is protected and **carries no note** when the rest sell out (the prototype's "the one in your basket is safe" note was dropped). Race behaviour is as built and unmeasured; revisit only if it bites. ([#28](https://github.com/KeeprDigital/shop-keepr/issues/28), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#4](https://github.com/KeeprDigital/shop-keepr/issues/4))

#### Fixed copy

Strings the tickets fixed:

| Where                | String                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Attract heading      | "What do you play?"                                                                          |
| Submit verb          | "Send to the counter"                                                                        |
| Number screen        | "Your number is 417 — go to the counter"; "put aside for 20 minutes" (TTL value substituted) |
| Basket footer        | "put aside while you shop"                                                                   |
| Idle overlay         | "Still there?"                                                                               |
| Race                 | "just gone"                                                                                  |
| Empty search         | "Nothing found in Magic. Check the spelling, or pick another game."                          |
| Switches             | "Group versions"; "In stock only"                                                            |
| Number screen button | "Done"                                                                                       |

Strings as prototyped on `prototype/kiosk-basket-flow`, not separately decided (disposable): Attract subline "Pick a game to browse the singles we have in stock."; search placeholder "Search Magic cards"; game button "Magic · change"; back link "‹ Back to results"; Condition row sublines "Last one" / "N available" / "N in your basket" / "Just gone — someone else took the last one"; Add button "Add" / "Add another"; no-stock Printing "Not in stock — Ask at the counter"; other-versions label "Other versions of {name}"; empty Basket "Your basket is empty — Find a card and tap Add."; Basket footer "Nothing is paid here. Your cards are put aside while you shop; you pay at the counter."; confirm sheet "Send this basket to the counter?" / "Staff will have it ready. You will get a number to quote." / name label "Your name (optional)" placeholder "So staff can call you" / "Keep shopping" / "Send it"; number screen "Go to the counter and say 417{, name}" and "N cards · £total · put aside for 20 minutes" and "Back to the start in N s"; idle overlay "Tap to keep your basket. Otherwise it clears and the cards go back on the shelf." / "I'm still here"; filter slideover "Filter Magic" / "Show results" / "Clear filters". ([#28](https://github.com/KeeprDigital/shop-keepr/issues/28), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

#### What a customer never sees

Market Price; Buy Price; pin markers or any marker; a countdown on the Hold (the idle ring is about the customer, not the Hold); withdrawn Printings; other Baskets; any ledger, cost or stock figure beyond available-to-add; a Total Percentage or Tender; any payment step. Enforced structurally: kiosk response schemas have no slot for staff fields. ([#6](https://github.com/KeeprDigital/shop-keepr/issues/6), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28))

#### Touch and accessibility constraints stated

Large targets; no modals (a stuck modal on a keyboardless touchscreen has no escape); Add on a page rather than a chip; full-word Conditions; the on-screen keyboard is the device's, not built; a real keyboard drove the prototype. The prototype deliberately did not build: on-screen keyboard, card images, the not-enrolled screen, pagination. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28))

## 8. Staff UI, screen by screen

Desktop-first. Component library: Nuxt UI v4 (dashboard layout, sidebar, panels, modals, slideovers, tables, command palette). One Nuxt 4 app; the kiosk is its own layout at `/kiosk/*` and is specified in the kiosk section. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

### Shell

- **Layout**: Nuxt UI dashboard shell. Collapsible left sidebar (collapses to icons at the counter), one panel per page, a **single banner slot** above the page. Top nav rejected (sidebar grows with follow-on work). ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Auth**: staff at `/`, login-gated at `/login`; one shared store login (Better Auth email+password, DB-backed session cookie). ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#3](https://github.com/KeeprDigital/shop-keepr/issues/3))
- **Landing after login is Lookup.** No dashboard, no home screen. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Page / panel / modal rule**: a page has a URL; a panel is a persistent region on a page (master-detail right pane); a modal is one focused commit or edit (Adjust, Pin, Commit, Complete, the Lookup card). Detail views are panels, never modals; the Lookup card is the one deliberate exception, decided by the owner. Panels and modals never get URLs. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- **Banner slot**: one. Staleness/drift from the Catalogue sync (either run past 2× its interval, or last run failed, or `completed_with_drift` with count and reason) wins over reprice-in-progress. Links to System. ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Reprice progress**: a slim indicator in the sidebar footer while a sweep runs, plus a line on System. **No per-price "updating" markers**; a mid-flight price is the previous price. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Pin marker**: a pin icon beside any pinned price wherever a price appears (Lookup rows, card modal, Transaction lines, Inventory, sessions, lists); tooltip: who, when, market now. Never on the kiosk. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Basket submissions**: toast + Queue badge, no sound. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Withdrawn Printings** (Catalogue `withdrawn: true`) carry a badge on every staff surface; staff can still sell what they hold. ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14))

#### Global keys

| Key     | Action                                                             |
| ------- | ------------------------------------------------------------------ |
| `Cmd+K` | Command palette, thin in the MVP: page jump + Basket Number lookup |
| `/`     | Focus the page's search box                                        |
| `Esc`   | Close the open panel / modal / submenu (innermost first)           |

([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

#### Nav order and routes

| #   | Nav item       | Route(s)                       | Badge                                     |
| --- | -------------- | ------------------------------ | ----------------------------------------- |
| 1   | Lookup         | `/`                            | —                                         |
| 2   | Transaction    | `/transaction`                 | line count of the uncommitted Transaction |
| 3   | Queue          | `/queue`                       | submitted Baskets                         |
| 4   | Customer Lists | `/lists`, `/lists/:id`         | —                                         |
| 5   | Large Buy      | `/large-buy`, `/large-buy/:id` | a session `committing`                    |
| 6   | Ingest         | `/ingest`, `/ingest/:id`       | a session `committing`                    |
| 7   | Inventory      | `/inventory`                   | —                                         |
| 8   | Pinned Prices  | `/pinned`                      | stale pins (drift or age)                 |
| 9   | History        | `/history`                     | —                                         |
| 10  | Settings       | `/settings`                    | —                                         |
| 11  | System         | `/system`                      | —                                         |

Order is #26's, amended by #46 (Transaction inserted after Lookup). Nav order is a guess at counter frequency (accepted gap). ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

### Lookup `/`

**Purpose**: "do we have X, how many". The counter's home; Sell and Buy are actions taken from what Lookup found. Lookup is a search, not a workbench: nothing on a result row is clickable but the row. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Layout**

- Sticky **Game System selector**, remembered per browser (last used). Search is game-scoped; one implementation shared with the kiosk and every other staff search (the five-tier cascade of [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)). ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31))
- Search box. **In-stock filter OFF** by default, so a found-but-unstocked card reads _found, none held_ rather than _not found_. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31))
- **Group by Card** switch, default off. On: Card-name headers over the Printing rows. ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- Results: a compact list, **one row per Printing**. ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- **Transaction bar**: a slim bar on the page while the uncommitted Transaction has lines: _Transaction · 6 lines · Trade · net −£36 · Open →_. Links to `/transaction`. No draft panel, no inline search on the Transaction page: the loop is search → card → Sell / Buy → search. ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Result row (per Printing)**: thumbnail, name, set code + collector number, finish, held count (or _none held_), Market Price, Sell Price (range across held Conditions; blank when none held), Buy Price at NM, pin marker, withdrawn badge. Columns are "a starting point, not a decision on every field" (accepted gap). ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14))

**Card modal** (opens from a row; every action lives here):

- Header: image, set, finish, Market Price, Buy NM, held count.
- **SKUs held** table: Condition · Language · on-hand · available (with _N held by Basket 4821_ when a Hold is active) · Sell · Buy, pin markers, a **Sell** button per row (disabled at on-hand 0).
- **Buy** row: Condition / Language picker (defaults NM + store Language), **Buy** button. Buy is offered on every Printing, held or not; a never-held Printing's Buy Price is rule-computed on read and nothing in the UI says so. ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#27](https://github.com/KeeprDigital/shop-keepr/issues/27))
- **"…" submenu**: **Adjust** (opens the Adjust modal for a held SKU), **Pin** (modal: side Sell / Buy, value).
- **On-hand 0 block**: a SKU at on-hand 0 cannot be sold; the row reads _none held — record a `found` Adjustment first_ and the `found` link opens the Adjust modal pre-set to Reason `found`. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))
- **Held-by-Basket warning**: selling a copy held by a submitted Basket proceeds (bounded by on-hand, not available) with a warning naming the Basket Number; the physical card wins, the Basket takes the shortfall path. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31))
- The modal **stays open** after Sell or Buy (both sides of one card in one visit). Master-detail was tried and rejected. ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Keys**

| Key       | Where     | Action                                                                                |
| --------- | --------- | ------------------------------------------------------------------------------------- |
| `↑` / `↓` | results   | move highlight; with the card open, steps to the next / previous card                 |
| `Enter`   | results   | open the highlighted card                                                             |
| `S`       | card open | add the first held copy (NM + store Language first, else first held) to the Sell side |
| `B`       | card open | add at the picked Condition / Language to the Buy side                                |
| `Esc`     | card open | close submenu → close card → clear search                                             |

([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Commit path**: none here. Sell / Buy append a line to the browser-local Transaction; commit happens on `/transaction`.

### Transaction `/transaction`

**Purpose**: the one uncommitted Transaction for the customer at the counter, built from Lookup, committed once as a Buy, a Sell or a Trade according to which sides hold lines. There is no "start a Trade" mode. "Draft" is retired as a word. ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Layout (variant C)**

- **Two columns**: Buy left, headed _cards in_; Sell right, headed _cards out_. A side with no lines is collapsed. ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- **Line row** (both sides): thumbnail, name, set/number, finish, Condition, Language, quantity, Market Price, price (Sell Price or Buy Price; overridden shows the struck rule price and a revert), pin marker, held-by-Basket warning on a Sell line, block state on a Sell line whose on-hand is 0 with the `found` Adjustment link. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- **Column footers**: each side's **Total Percentage** (signed integer, −100..+100, starts 0, applies to the whole side, never spread to lines) and its Total. Buy footer also carries the **tender toggle** (`cash` / `credit`, pre-filled from Default Tender); lines stay at the Default Tender price, the toggle applies the Tender Modifier to the total. Two Total Percentages in view at once is accepted. ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- **Balance** beneath the columns once both sides have lines: tilts to the heavier side; then the net. Three money figures, never two: Buy Total (shown in **credit** on a Trade, whatever Default Tender is), Sell Total, net. ([#44](https://github.com/KeeprDigital/shop-keepr/issues/44), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))
- **Trade tender**: while both sides have lines, the Buy's own tender toggle is **hidden** (its `tender` is `credit`), and the Remainder tender lives only on the balance as a segmented control carrying both figures. It returns when the Sell side empties. ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Balance copy** (plain words; _Covered_ and _Remainder_ stay glossary-only):

| Case                  | On screen                                                                                         | Control                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Store owes (C > S)    | _Their cards are worth £45 more than the sale (£80 of them pays for it). Left over as …_          | segmented: _credit £45_ / _cash £36_, default Default Tender |
| Customer pays (S > C) | _The sale is worth £20 more than their cards (all £80 of them pays toward it). Customer pays £20_ | same place, same shape, disabled, reading _at the POS_       |
| Even (S = C)          | _Their cards cover the sale exactly. Nothing changes hands._                                      | —                                                            |

Figures per [#44](https://github.com/KeeprDigital/shop-keepr/issues/44)'s table (store's perspective): credit `−(C − S)`, cash `−K × (1 − S/C)`, customer pays `+(S − C)`, even `0`. Total Percentage applies to each side before the split. ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Keys** (the shared row-editing model; arrows **cross sides**, one list to walk):

| Key                    | Where    | Action                                                                                                                                         |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tab`                  | page     | enter the newest line of the last-touched side                                                                                                 |
| `↑` / `↓`              | in a row | previous / next row, continuing into the other side at the boundary                                                                            |
| `Tab` / `Shift+Tab`    | in a row | next / previous row; past the end leaves the row                                                                                               |
| `N` `L` `M` `H` `D`    | in a row | Condition NM / LP / MP / HP / DMG. Sell side: a grade the store does not hold is refused with a toast (_No LP copy held — condition stays NM_) |
| digits                 | in a row | quantity (consecutive digits within ~1 s compose; 1..999)                                                                                      |
| `E` `J` …              | in a row | Language from the store's list (`E`/`J` were the prototype pair; the real keys follow the store's Language list)                               |
| `P`                    | in a row | edit the line price; `Enter` commits, `Esc` cancels                                                                                            |
| `Backspace` / `Delete` | in a row | remove the line, move to the neighbour                                                                                                         |
| `Enter` / `Esc`        | in a row | leave the row                                                                                                                                  |

A regrade that collides with an existing line merges into it. ([#27](https://github.com/KeeprDigital/shop-keepr/issues/27), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46))

**Validation**

- Sell lines bounded by **on-hand**, not available; on-hand 0 (or quantity above on-hand) blocks commit until a `found` Adjustment is recorded. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31))
- A per-line price edit never changes the SKU's price and never pins; the line stores list price and transacted price. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11))
- Removed lines (declined cards) are never recorded. ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11))
- No Holds are created by the Transaction. ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31))

**Commit** (modal): heading _Commit Buy / Sell / Trade_; the three figures (on a Trade: Sell Total · Buy Total credit · net, with the Remainder tender named); the header columns each half will write (`tender`, `tender_modifier_pct`, `total_pct`, `remainder_tender`, `total`, `net`); **POS Reference** (opaque, non-empty, required, not unique; captured after the POS has moved the money; `Enter` commits when non-empty); Cancel / Commit. Commits **once**, atomically: a Sell through the Sell service `origin = counter`, a Buy through the Buy service `origin = counter`, a Trade both in one batch sharing `trade_id`. Nothing printed or sent; staff may show the customer the figures. ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#46](https://github.com/KeeprDigital/shop-keepr/issues/46), [ADR 0007](adr/0007-trade-is-a-linked-buy-and-sell.md), [ADR 0010](adr/0010-tender-and-total-factors-on-the-total.md))

**Persistence**: browser-local only. Survives refresh and navigation between pages; lost on a device change or cleared storage. No server-side entity, no Holds. An abandoned Transaction writes nothing. Cleared on commit. ([#11](https://github.com/KeeprDigital/shop-keepr/issues/11), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

### Queue `/queue`

**Purpose**: the kiosk Baskets awaiting collection at the counter. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

**Layout**: master-detail. Left: `submitted` Baskets (Basket Number, optional name, line count, expiry countdown, age). Right: the selected Basket's lines (Printing, Condition, Language, quantity, snapshotted price) with per-line **Remove** and the **Complete** button. An **Expired** tab lists Baskets `expired` within the 24 h revival window with **Revive**. New submissions arrive as a toast plus the nav badge; polling by cursor behind a subscription interface. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#4](https://github.com/KeeprDigital/shop-keepr/issues/4))

**Actions**

| Action                                                                           | Effect                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove line** (with Reason: `not-found` default, `customer-declined`, `other`) | line dropped with its Reason recorded; that line's Hold released; Basket stays `submitted`. Partial fulfilment is normal.                                                                                                                                |
| **Complete** (modal: POS Reference required; ≥ 1 line remaining)                 | Sell written through the Sell service, `origin = kiosk`, `basket_id` set, one line per remaining Basket line at the **snapshotted** price, `total_pct` null; Holds released; Basket → `fulfilled`. A Basket with every line removed cannot be completed. |
| **Cancel** (no Reason)                                                           | Basket → `cancelled`, Holds released.                                                                                                                                                                                                                    |
| **Revive** (Expired tab, within 24 h)                                            | re-reserves per line; lines that fail are dropped; Basket → `submitted`, keeps its number.                                                                                                                                                               |

A submitted Basket's clock runs down with no reset and no manual extension. Shortfall from an unrecorded counter sale is fixed by recording that Sell on Lookup / Transaction; a shortfall with no sale behind it is an Adjustment (stock-count workflow, fog). The reasoned removals are that worklist. ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44))

### Customer Lists `/lists`, `/lists/:id`

**Purpose**: turn a list of cards a customer supplies into one Sell (from this screen) or one Large Buy session. A list holds no stock and fixes no price. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))

**Index `/lists`**: open lists (name, direction, Game System, line counts by state, age) + **New**. New asks, in order and before paste: **direction** (Buy / Sell, never mixed) and **Game System** (one per list), then name + details (free text) and the paste box. A customer selling some and wanting others is two lists → two Transactions sharing one POS Reference. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))

**Paste grammar** (free text only; one lenient grammar; no format detection):

- One card per line.
- Optional quantity: `4 Lightning Bolt`, `Lightning Bolt x4`, `4x Lightning Bolt`.
- Optional `(SET)` set code.
- Optional trailing collector number.
- Section headers (`Deck`, `Sideboard`), blank lines and comments ignored.
- Covers Moxfield / Archidekt / Arena text exports.
- **Refused**: files, photos, email, URLs. Nothing else refused: an unparseable line becomes `unresolved` with its raw text kept. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))

**List `/lists/:id`**: lines with state chips, a per-line **candidate picker** (set code, collector number, finish, thumbnail), **Drop**, an append-by-search box (the #35 entry loop), the **copyable plain-text summary**, and the convert / commit action.

**Resolution** (runs per line on paste, re-runs on open):

1. The #24 cascade on the name, narrowed by set code / collector number when present.
2. Sell lists narrow candidates first to Printings with on-hand > 0; Buy lists never narrow by stock.
3. Exactly one candidate → `resolved`; many → `unresolved`, **never guessed**; staff pick per line. No bulk disambiguation.
4. Duplicate lines merge on the same Printing.

Line states `resolved` / `unresolved` / `dropped` (no Reason; a list is not the ledger). Unresolved never blocks working the list; **converting requires every line resolved or dropped**. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24))

**Sell-direction lines**: SKU fill best Condition first in store Language until quantity met (requested 4, held 2 NM + 3 LP → two lines, 2 NM + 2 LP), all editable with the shared row keys; bounded by on-hand with the held-by-Basket warning and the on-hand-0 block; **shortfall per line** (_2 of 4_), recomputed live on every open. Prices live (SKU Sell Price), per-line transacted price editable, Sell **Total Percentage** in the footer. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33), [#27](https://github.com/KeeprDigital/shop-keepr/issues/27), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44))

**Buy-direction lines**: show Buy Price at NM as _up to_; no grading here.

**Customer summary**: plain text, copyable: resolved lines with qty and price, total, then not-held / not-found lines. No sending, no PDF, no customer entity. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))

**Commit / convert**

- **Sell list**: **Commit** modal (POS Reference required, after payment) → Sell service, `origin = list`, `total_pct` as typed; list → `converted`. Never pushed into the counter Transaction. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33), [#44](https://github.com/KeeprDigital/shop-keepr/issues/44))
- **Buy list**: **Open as Large Buy** (enabled only when clean) → creates a Large Buy session pre-filled with the lines at NM + store Language, `origin = list`, with a back-link; list → `converted` with a link to the session. No unresolved carry-over. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35))
- **Abandon** → `abandoned`; kept forever.

**Storage**: own table (direction, game, raw text, name, details, state `open` / `converted` / `abandoned`, per-line state), not a third `kind` on the session table. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))

### Large Buy `/large-buy`, `/large-buy/:id` and Ingest `/ingest`, `/ingest/:id`

Two screens over one entry-loop component; never one screen with a mode. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))

**Index (both)**: open sessions (name, line count, Market Price total, age; Large Buy also Buy total) + **New** (name + details, free text: "Dave's binder"). A session `committing` shows progress and lights the nav badge. Abandoned sessions kept, not deleted. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35))

**Session (both)**: search box at the top; line list **newest at top**; per line: thumbnail, name, set code, collector number, finish, Condition, Language, quantity, Market Price; running **Market Price total** (staff-only). Results show set code, collector number, finish, thumbnail; **newest set first**; `name SET` / `name #n` narrows. Set boost **dropped** from the MVP. Results also show what the store holds. ([#27](https://github.com/KeeprDigital/shop-keepr/issues/27), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35))

**Entry loop and keys**

| Key                    | Where                     | Action                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typing                 | search                    | filters results                                                                                                                                                                                                                        |
| `↑` / `↓`              | search                    | move highlight                                                                                                                                                                                                                         |
| `Enter`                | search                    | append the highlighted Printing at **NM + store Language, qty 1**; focus stays in search. Same Printing + Condition + Language merges (qty +1); the merged line moves to the top and flashes _merged: Lightning Bolt (LEA) NM, now ×2_ |
| `Esc`                  | search                    | clear the box (**never deletes**)                                                                                                                                                                                                      |
| `Tab`                  | search                    | enter the newest line                                                                                                                                                                                                                  |
| `↑` / `↓`              | in a row                  | previous / next line                                                                                                                                                                                                                   |
| `N` `L` `M` `H` `D`    | in a row                  | Condition; a regrade colliding with an existing line merges into it                                                                                                                                                                    |
| digits                 | in a row                  | quantity, 1..999                                                                                                                                                                                                                       |
| `E` `J` …              | in a row                  | Language from the store's list                                                                                                                                                                                                         |
| `P`                    | in a row (Large Buy only) | edit the line's Buy Price; marked with the struck rule price and a revert; this line only, never pins                                                                                                                                  |
| `Backspace` / `Delete` | in a row                  | delete the line                                                                                                                                                                                                                        |
| `Enter` / `Esc`        | in a row                  | back to search                                                                                                                                                                                                                         |

Sticky = **store defaults** (every line starts NM + store Language). Never-held Printings are indistinguishable on screen; the pin icon is the only per-line difference and is a pin fact. ([#27](https://github.com/KeeprDigital/shop-keepr/issues/27), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35))

**Large Buy only**

- Per line: rule-derived **Buy Price** (evaluated with the line quantity through Quantity Bands; one price per line) and override. Running **Buy total**. ([#48](https://github.com/KeeprDigital/shop-keepr/issues/48))
- Whole-Buy controls, on the total only: **tender toggle** (`cash` / `credit`, pre-filled from Default Tender; lines stay at the Default Tender price) and **Total Percentage** (signed, −100..+100). ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#27](https://github.com/KeeprDigital/shop-keepr/issues/27))
- **Commit** modal: total, net, POS Reference required. One Buy through the Buy service, `origin = large_buy` (or `list` when opened from a Customer List), atomic in one batch; SKU rows upserted. The customer is told the total **verbally**; nothing generated or printed. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35), [#27](https://github.com/KeeprDigital/shop-keepr/issues/27), [#11](https://github.com/KeeprDigital/shop-keepr/issues/11))
- No fix list on a Large Buy. ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33))

**Ingest only**

- **Reason** at the top, chosen once per session: `initial-load` or `found`. No Buy column, no price anywhere; Market Price stays. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35), [#27](https://github.com/KeeprDigital/shop-keepr/issues/27))
- **Import file** button on the session (not a separate screen). CSV only. **Column mapping every time**, no saved mappings: name, set code, collector number, condition, language, quantity. Matching runs as a background job (Cloudflare Workflow) with progress on the session. Rule: name required; set code and collector number used when present; a bare name matching exactly one Printing matches; many → unmatched, never guessed. Condition / language / quantity default NM / store Language / 1. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))
- **Fix list** on the same screen: unmatched rows, each with a search box to pick the Printing by hand, or Drop. **Commit is allowed with rows still unfixed**; they stay on the session as not-yet-ingested. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))
- **Commit**: one Adjustment header with the session's Reason, lines written in chunks under D1 batch caps; session `committing` until every chunk lands, resumable on failure. Never-held SKUs get rule-computed prices on upsert; pinning happens afterwards. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))

**Session storage**: one table, `kind` (`large_buy` / `ingest`), state `open` / `committing` / `committed` / `abandoned`, name, details, Reason (Ingest), lines (`printing_id`, condition, language, quantity, price override on Large Buy). Server-side because a pile spans breaks and machines. Market Price read live at render, never snapshotted. No Holds. ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35))

### Inventory `/inventory`

**Purpose**: "what do we hold". Stock-first table of SKUs where `on_hand > 0 OR pinned`. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

| Element     | Spec                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filters     | Game System; name search (same cascade); **Withdrawn with stock** chip (the #14 worklist; the fix is an Adjustment on the row)                                          |
| Columns     | Printing (name, set, number, finish), Condition, Language, on-hand, held (active Holds), Sell Price, Buy Price, Market Price, pin markers, `priced_at`, withdrawn badge |
| Sort        | any column                                                                                                                                                              |
| Row actions | **Sell** (adds to the Transaction; on-hand-0 block and held warning as on Lookup) · **Adjust** · **Pin**                                                                |

([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14))

### Pinned Prices `/pinned`

All Pinned Prices, one row per pin (SKU, side, pinned value, market now, drift %, who, when, age). Rows flagged **stale** by drift past the pin drift threshold (default 25%) or age past the pin age threshold (default 90 days); the nav badge counts stale pins. No banner, no toast; an alert never changes a price. ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

| Action     | Effect                                             |
| ---------- | -------------------------------------------------- |
| **Re-pin** | new value, new who/when                            |
| **Unpin**  | `price_source` back to `rule`; next sweep reprices |
| **Keep**   | resets the age clock only                          |

### History `/history`

Read-only list of Buy / Sell / Adjustment entries: date, kind, origin (`kiosk` / `counter` / `list` / `large_buy`), POS Reference, line count; search by POS Reference; detail panel showing header (`total`, `net`, `tender`, factors) and lines. **No actions**: corrections and returns stay fog. Exists so yesterday's Sell can be found. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31))

### Adjust modal

Reachable from any SKU row on Lookup (card modal submenu) or Inventory, and from the `found` link on the on-hand-0 block. No standalone Adjustments page; the stock-count workflow stays fog. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

| Field   | Spec                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SKU     | fixed from the row (Printing, Condition, Language)                                                                                              |
| Change  | quantity **delta** or **new count** (one of the two)                                                                                            |
| Regrade | optional target Condition; writes two balanced lines (−n old, +n new), Reason `condition-regrade`                                               |
| Reason  | enum, required: `miscount`, `damage`, `shrinkage`, `found`, `condition-regrade` (`initial-load` is the Ingest session Reason, not offered here) |
| Note    | optional                                                                                                                                        |

Writes one Adjustment (kind `adjustment`, no POS Reference, on-hand stays ≥ 0). ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

### Settings `/settings`

Tabs: **General** · **Game Systems** · **Kiosks** · **Pricing**. The Pricing tab is the setting-first page specified in the pricing section ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)). ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

| Tab          | Setting                                                                                                                            | Default / range                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| General      | Trading currency                                                                                                                   | one per store                                    |
| General      | Default Language                                                                                                                   | BCP 47 from the controlled list                  |
| General      | Hold expiry (Basket TTL)                                                                                                           | 20 min; 5–120 min                                |
| General      | FX rate + step threshold                                                                                                           | stepped rate, threshold 2%; manual set on System |
| General      | Pin drift threshold                                                                                                                | 25%                                              |
| General      | Pin age threshold                                                                                                                  | 90 days                                          |
| Game Systems | `enabled` switch per Game System (shown to customers on the kiosk)                                                                 | traded-but-hidden flag is a follow-on            |
| Kiosks       | **Enrol this device** (mints an API key, single-use short-TTL enrolment code typed into the kiosk once), enrolled list, **Revoke** | —                                                |
| Pricing      | Default Tender (`cash` / `credit`, seed `cash`) and Tender Modifier (%, seed 0) live in Pricing › Buy › Tender, store-level only   | see pricing section                              |

Not surfaced in the MVP UI: sync intervals (Catalogue 6 h, Market Price 24 h, reconcile weekly). ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [ADR 0003](adr/0003-stepped-exchange-rate.md))

### System `/system`

Health, not config. ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

| Block                           | Contents                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue sync, per Game System | last `sync_run` per kind (`catalogue`, `market_price`): status (`running` / completed / `completed_with_drift` / failed), finished at, cursor from → to, records seen / written / quarantined / drifted, error; "Catalogue synced X ago / prices as of Y" from `finished_at`; **Refresh now** (delta) and **Rebuild** (Catalogue run from cursor zero); run history |
| Staleness                       | either run past 2× its interval, or last failed → state shown here and the banner everywhere                                                                                                                                                                                                                                                                        |
| FX                              | stepped rate in force, last fetched rate, fetched at, **Set manually**                                                                                                                                                                                                                                                                                              |
| Reprice                         | progress line while a sweep runs (_Repricing Magic: 1,240/8,000_)                                                                                                                                                                                                                                                                                                   |
| Projection                      | on-demand run of the on-hand reconcile; `projection_drift` count (empty = healthy)                                                                                                                                                                                                                                                                                  |

([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#26](https://github.com/KeeprDigital/shop-keepr/issues/26))

## 9. How the build proceeds

The order below follows the dependencies, not priorities: each layer is testable before the next exists, and the Catalogue never blocks a step.

| Step                       | Delivers                                                                                                                                                                                                               | Testable by                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Shared types and schema | `shared/` (Condition, Language, `Money`, error codes); Drizzle schema and migrations for every table in §3, §4 and §7; D1 created with a region hint                                                                   | `drizzle-kit generate`, migrations apply on local D1                                                                                                            |
| 2. Contract layer          | Committed OpenAPI document, `pnpm catalogue:contract`, generated TS types + Zod 4 schemas, CI freshness check, the committed fixture (§5, _Environments and test tiers_)                                               | Contract tests offline against the fixture                                                                                                                      |
| 3. Mirror sync and search  | The Workflow (`catalogue` and `market_price` runs), `sync_run`, quarantine, the per-game modules with their search tables, FTS index writes, `token_trigram`, the fold library, the five-tier cascade as one `batch()` | Unit tests for hash-compare, cursor ordering and quarantine; `pnpm catalogue:seed` against staging; recall against `spike/typo-search/data/all-card-names.json` |
| 4. Ledger services         | Sell service, Buy service, Adjustment write, Trade commit, `on_hand` projection with `AND EXISTS` guards, reconcile job and `projection_drift`, inline Buy Price recompute                                             | Unit tests on the commit batch shape; the hold-atomicity spike's pattern for the projection                                                                     |
| 5. Pricing                 | Settings model, resolution, evaluator (port the DOM-free module on `prototype/pricing-settings`), the queue-backed sweep, stepped FX, Pinned Price                                                                     | Evaluator unit tests; sweep against a seeded `sku` table                                                                                                        |
| 6. Auth                    | Better Auth: staff email + password session, kiosk API key cookie on `/api/kiosk`, route guards                                                                                                                        | e2e runner                                                                                                                                                      |
| 7. Kiosk                   | `/kiosk` layout, game gate, search, Printing page, Basket, Holds and reservation, submit, idle behaviour, polling                                                                                                      | e2e runner; reservation under concurrency                                                                                                                       |
| 8. Staff UI                | Lookup, Transaction, Queue, Customer Lists, Large Buy, Ingest, Inventory, Pinned Prices, History, Settings (Pricing tab per §6), System                                                                                | e2e runner                                                                                                                                                      |
| 9. Operations              | Cron Triggers (Hold sweeper, sync scheduler), scheduled ledger dump to R2, staff banner, System page                                                                                                                   | Deferred deployment work names the rest (§10)                                                                                                                   |

**Prototypes are references, not code to ship.** Four prototype branches hold the chosen UI variants and one reference evaluator: `prototype/kiosk-basket-flow` ([#28](https://github.com/KeeprDigital/shop-keepr/issues/28)), `prototype/counter-trade` ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46)), `prototype/large-buy-entry` ([#27](https://github.com/KeeprDigital/shop-keepr/issues/27)), `prototype/pricing-settings` ([#42](https://github.com/KeeprDigital/shop-keepr/issues/42)). Read them for copy, bindings and behaviour; rebuild in Nuxt UI v4.

**Test facts fixed by the map** ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23)):

- `server/api` routes cannot be unit-tested in the `nuxt` vitest environment; only the e2e runner exercises them. The runner builds the Worker under the Cloudflare preset, applies the migrations to the local D1 and serves the build with `wrangler dev` ([#54](https://github.com/KeeprDigital/shop-keepr/issues/54)). Keep route handlers thin and the logic behind them unit-testable; code that talks to D1 is tested in the `db` vitest project, which runs inside workerd against a fresh local D1.
- The sync module takes `{ fetch, baseURL, credential }`; tests pass a `fetch` that serves the committed fixture. Nuxt's `registerEndpoint` does not intercept absolute URLs; do not build a second code path for tests.
- Every commit runs unit and contract tests against the fixture, offline. The merge gate runs integration tests against Catalogue **staging**. Production is never an automated test target.
- Never measure search on a generated corpus; use the real card-name corpus in `spike/typo-search/data/`.

**Repo conventions already in place**: pnpm, Node ≥ 22, `pnpm lint` (antfu config, tabs and semicolons), `pnpm typecheck`, `pnpm test` (vitest: `test/unit` in the Nuxt environment, `test/db` inside workerd), `pnpm test:e2e` (Playwright, `test/e2e`, against the built Worker). Nitro Cloudflare preset, `wrangler.jsonc` with the D1 binding, Drizzle schema in `server/db/schema` with migrations in `server/db/migrations` (`pnpm db:generate` → `pnpm db:migrate`), and `shared/` with Condition, Language, `Money` and error codes ([#54](https://github.com/KeeprDigital/shop-keepr/issues/54)).

## 10. Deferred, open, and at risk

### 10.1 Deferred

In scope for the product, deliberately not decided for the MVP. Each is the map's remaining fog; a follow-on effort charts it. None blocks the build.

- **Deployment, environments, secrets, CI on Cloudflare.** Workflow, Queue and Cron Trigger bindings; the per-environment Catalogue credential and `BETTER_AUTH_SECRET` as secrets; the OpenAPI freshness check and the `@better-auth/utils` version assertion in CI; the scheduled ledger dump to R2. §2 names the bindings; the pipeline around them is not designed ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#3](https://github.com/KeeprDigital/shop-keepr/issues/3)).
- **Test strategy** beyond the tiers in §5 and the facts in §9: what is unit-tested and what Playwright covers is chosen during the build ([#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).
- **Stock counts, corrections and returns as a staff workflow.** Entry points exist (Adjust modal, History, the `found` Adjustment link at on-hand 0, kiosk reasoned removals, withdrawn-with-stock chip, an Ingest's unfixed rows). A stock-take, a return, a bulk regrade, and the "Undo this Buy" UI for Reversals are not designed. History has no actions ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#31](https://github.com/KeeprDigital/shop-keepr/issues/31), [#35](https://github.com/KeeprDigital/shop-keepr/issues/35), [#7](https://github.com/KeeprDigital/shop-keepr/issues/7)).
- **Ingest import formats beyond CSV** (Excel, TCGplayer, Cardmarket, Manabox). Waits on a real file ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)).
- **Per-staff users.** Audit columns exist and backfill; the migration itself, the `picking` Basket state, and Cloudflare Access on staff paths all wait for it ([#7](https://github.com/KeeprDigital/shop-keepr/issues/7), [#3](https://github.com/KeeprDigital/shop-keepr/issues/3), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- **Customer List input beyond pasted text** and **Trade via lists** ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).
- **Push transport** (Durable Object or Ably) when the §7 upgrade triggers hold ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).
- **Search extras**: mid-name substring search (trigram-tokenizer FTS), keyset pagination, a scoring function if rank-1 ordering disappoints, Facets denormalised onto `sku` when the empty-facet tail bites above ~10k SKUs ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24), [#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).
- **Smaller UI follow-ons**: a traded-but-hidden-from-kiosk Game System flag; sync intervals in Settings; bulk disambiguation on Customer Lists; a Market Price trend indicator at the Buy counter; target-total entry deriving a Total Percentage; the "try a price" sample card following the selected setting ([#26](https://github.com/KeeprDigital/shop-keepr/issues/26), [#33](https://github.com/KeeprDigital/shop-keepr/issues/33), [#21](https://github.com/KeeprDigital/shop-keepr/issues/21), [#43](https://github.com/KeeprDigital/shop-keepr/issues/43), [#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).
- **The Catalogue window** closes when the Catalogue is considered ready for market; requirements filed after that cost more ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

### 10.2 Open build choices

Fixed in behaviour by a ticket, not in name or number. The build picks; nothing needs a decision ticket.

| Area               | Open                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema names       | Column names for pin provenance, the Buy line snapshot fields, the session, Customer List and Basket line tables, `printing` set / collector / finish columns, the remaining per-game search table names, the quarantine table, the conversion links on sessions and lists                   |
| Sync               | Full `sync_run.status` enum; whether cursors live on `sync_run` or their own table; rows per statement and pages per step as build constants                                                                                                                                                 |
| Search             | Exact FTS5 declaration per game table (external-content over `name_folded`, `prefix=` for typeahead); minimum token length to fuzz in tier 5; the Unicode fold form (`[^\p{L}\p{N}]+`, per the measured spike)                                                                               |
| Pricing            | Seed values for percentages, Condition and Language multipliers, floors and rounding; the physical settings table; the Catalogue's price currency (prototype assumed USD → GBP)                                                                                                              |
| Holds and Baskets  | `UNIQUE(basket_id, sku_id)` as the retry idempotency key (spike recommendation); whether a Hold-expiry setting change touches Baskets in flight; how Keep resets the pin age clock; Ingest chunked-commit idempotency key; whether a Customer List's Sell fill split is stored or recomputed |
| Kiosk and staff UI | Number-screen route; kiosk and staff poll intervals (~3 s); kiosk rate-limit values; kiosk pagination; Language hotkeys beyond `E`/`J`; the multi-digit quantity compose window; Nuxt UI v4 component mapping                                                                                |
| Auth               | Better Auth session `expiresIn` / `updateAge` (library defaults stand)                                                                                                                                                                                                                       |

### 10.3 Risks

Accepted knowingly. Each names what would reopen it.

- **Search ranking is untested.** Every measured figure is recall; rank-1 ordering was never scored. Fix inside D1 (`bm25()`, length-normalised overlap), not a new engine ([#24](https://github.com/KeeprDigital/shop-keepr/issues/24)).
- **Scale figures are extrapolated.** Trigram and vocabulary numbers beyond 38,001 names are Heaps-law estimates; `printing_detail` size was measured on a stand-in record; the Printing count is uncensused. Re-measure when the contract freezes ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17), [#24](https://github.com/KeeprDigital/shop-keepr/issues/24)).
- **The pricing sweep is untested at scale.** First thing to measure once `sku` has real rows ([#8](https://github.com/KeeprDigital/shop-keepr/issues/8)).
- **External-content FTS5 goes silently stale** if any write path skips it. The worst failure in the system; the sync module is the only writer ([#13](https://github.com/KeeprDigital/shop-keepr/issues/13)).
- **`batch()` is atomic, not conditional.** Every dependent statement in every multi-row write carries an `AND EXISTS` guard, forever ([#4](https://github.com/KeeprDigital/shop-keepr/issues/4)).
- **Whole-database export is lost** to FTS5; per-table dumps and Time Travel remain; the ledger dump to R2 is an unbuilt obligation ([#17](https://github.com/KeeprDigital/shop-keepr/issues/17)).
- **Unmeasured defaults**: sync cadences and the 2× staleness rule; Hold expiry 20 min; idle 60 s + 30 s; 24 h revival; 30 s auto-return; 2 % FX step; 25 % / 90-day pin thresholds; the ~1,000-SKU sweep-confirm line. Tune from use ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14), [#10](https://github.com/KeeprDigital/shop-keepr/issues/10), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28), [#8](https://github.com/KeeprDigital/shop-keepr/issues/8), [#42](https://github.com/KeeprDigital/shop-keepr/issues/42)).
- **Phantom stock** between a `not-found` removal and its Adjustment. Promote `not-found` to an automatic Adjustment, additively, if it bites ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- **Counter and kiosk race** on the same copy is handled only by the kiosk shortfall path; frequency unmeasured ([#31](https://github.com/KeeprDigital/shop-keepr/issues/31)).
- **`pos_reference` is editable** on an otherwise append-only header with no edit audit ([#10](https://github.com/KeeprDigital/shop-keepr/issues/10)).
- **Language on the SKU** is a bet that non-default-language stock stays rare; the exit runs through ledger history ([ADR 0002](adr/0002-language-on-sku.md)).
- **Stepped FX** holds for one currency, wide margins and small daily moves ([ADR 0003](adr/0003-stepped-exchange-rate.md)). **Which market the Catalogue's rate reflects** is unverified; store multipliers absorb divergence ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)).
- **No bound on Tender Modifier**; 200 % is honoured ([#43](https://github.com/KeeprDigital/shop-keepr/issues/43)).
- **The cursor guarantee is trusted.** A violated guarantee shows only as the weekly reconcile's drift count ([#14](https://github.com/KeeprDigital/shop-keepr/issues/14)). **Nothing verifies staging is pinned often enough** to gate merges on ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).
- **Young dependencies**: Drizzle v1 RC, both OpenAPI generators pre-1.0, Workflows limits may move, D1 read replication in beta. Pin exact versions ([#2](https://github.com/KeeprDigital/shop-keepr/issues/2), [#9](https://github.com/KeeprDigital/shop-keepr/issues/9), [#14](https://github.com/KeeprDigital/shop-keepr/issues/14)).
- **Workers Paid is required** (scrypt CPU; D1 row caps). Native scrypt cost on Workers is unpublished; smoke-test one sign-in on a deployed preview ([#3](https://github.com/KeeprDigital/shop-keepr/issues/3)).
- **UI decided from prototypes**, not the counter: Lookup columns and the card modal are a starting point; keystroke counts are a model; kiosk hardware is assumed; "Group versions" and the price range were decided from description ([#46](https://github.com/KeeprDigital/shop-keepr/issues/46), [#27](https://github.com/KeeprDigital/shop-keepr/issues/27), [#28](https://github.com/KeeprDigital/shop-keepr/issues/28)).
- **Where the store's current inventory lives was never established**; CSV plus mapping is a bet ([#35](https://github.com/KeeprDigital/shop-keepr/issues/35)). **The paste grammar** is a guess at what customers paste ([#33](https://github.com/KeeprDigital/shop-keepr/issues/33)).
- **Per-consumer Catalogue identity** is built for a second consumer that may never arrive ([#23](https://github.com/KeeprDigital/shop-keepr/issues/23)).

## 11. Decision records

| ADR                                                       | Decision                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](adr/0001-append-only-ledger.md)                    | Stock is an append-only ledger, corrected by compensating entries                                                                         |
| [0002](adr/0002-language-on-sku.md)                       | Language belongs to the SKU, not the Printing                                                                                             |
| [0003](adr/0003-stepped-exchange-rate.md)                 | Currency conversion happens in shop-keepr, on a stepped exchange rate                                                                     |
| [0004](adr/0004-configurable-pricing-pipeline.md)         | Pricing is a configurable ordered pipeline, not a fixed formula                                                                           |
| [0005](adr/0005-catalogue-observes-shop-keepr-decides.md) | The Catalogue asserts observations; shop-keepr asserts policy                                                                             |
| [0006](adr/0006-basket-owns-the-hold-clock.md)            | The Basket owns the expiry clock, not the Hold                                                                                            |
| [0007](adr/0007-trade-is-a-linked-buy-and-sell.md)        | A Trade is a linked Buy and Sell, not a third ledger kind                                                                                 |
| [0008](adr/0008-mirror-is-two-read-models.md)             | The Catalogue mirror is two read models, split by who reads them                                                                          |
| [0009](adr/0009-catalogue-change-is-one-cursor-walk.md)   | Catalogue change arrives through one cursor walk; seed, delta and reconcile are the same run                                              |
| [0010](adr/0010-tender-and-total-factors-on-the-total.md) | Tender and whole-Transaction factors act on the total and are snapshotted on the header                                                   |
| [0011](adr/0011-d1-is-the-one-database.md)                | D1 is the one database, for stock and for search                                                                                          |
| [0012](adr/0012-search-is-a-cascade-in-d1.md)             | Card search is a five-tier cascade in D1, with typo tolerance per token                                                                   |
| [0013](adr/0013-catalogue-contract-and-test-tiers.md)     | The Catalogue is reached over HTTPS as a named consumer; staging's OpenAPI document is the contract; the fixture is the every-commit tier |
| [0014](adr/0014-holds-are-conditional-inserts.md)         | A Hold is reserved by one conditional insert in D1; no Durable Object                                                                     |
| [0015](adr/0015-better-auth-and-the-kiosk-principal.md)   | Better Auth for both identities; the kiosk is its own principal on its own API surface                                                    |

**Research** behind the platform choices lives in `docs/research/`; **spikes** with measured numbers in `spike/`. Neither is normative; this document and the ADRs are. Research written before a decision may recommend the opposite of what was decided.
