# Auth on Cloudflare Workers: staff login and kiosk device identity

Research findings for [issue #3](https://github.com/KeeprDigital/shop-keepr/issues/3). Researched 2026-09-07.

> **Where this lives.** The repo had no existing convention for research notes (`docs/adr/` is for
> decisions, `docs/agents/` for agent conventions). Research findings go in `docs/research/`,
> named `YYYY-MM-DD-topic.md`. If a later ticket promotes this to a decision, it becomes an ADR.

---

## Recommendation

**One library, two credentials, two API surfaces.**

| Surface | Mechanism |
|---|---|
| Staff internal UI | **Better Auth** email+password, DB-backed session cookie, `cookieCache` **off** |
| Kiosk screen | **Better Auth API Key plugin**, key delivered as an `HttpOnly` device cookie, read via `customAPIKeyGetter` |

Both credentials are rows in the same database, revoked the same way, provisioned from the same
admin UI. No second identity system, no per-MAU billing, no vendor holding the store's user list.

**Do not use Cloudflare Access as the primary mechanism.** It is a reasonable *extra* network-layer
lock on `/admin` later, once staff have individual identities. It cannot serve the kiosk, and for a
single shared login it adds a whole second identity system for no gain.

**Do not put the kiosk token in JavaScript-reachable storage.** The kiosk is a public touchscreen;
anything `localStorage` holds is one devtools session away from a customer. See
[Challenging the proposed kiosk shape](#challenging-the-proposed-kiosk-shape).

**Four hard requirements** fall out of this and belong in the deployment ticket:

1. **Workers Paid plan.** Free is 10 ms CPU per request; scrypt password hashing cannot fit.
2. **`compatibility_date` ≥ `2026-08-04`** (or `nodejs_compat`), for `node:crypto` scrypt.
3. **Pin `better-auth` ≥ 1.7.3 and assert `@better-auth/utils` ≥ 0.4.1 in CI.** Below that, Workers
   silently gets a ~5 s pure-JS scrypt. See [§1](#the-scrypt-trap-is-real-and-the-fix-is-a-version-pin).
4. **Use Better Auth's built-in D1/Kysely path for the auth tables, not the Drizzle adapter.**
   The Drizzle adapter has an open, unworkaroundable D1 date bug. See [§2](#do-not-use-the-drizzle-adapter-for-the-auth-tables-on-d1).

This last one is a direct correction to the ticket's framing of Better Auth as "self-hosted, Drizzle
adapter". Drizzle can still own the *application* schema; it should not own the *auth* schema on D1.

---

## 1. Runtime: what Workers actually gives an auth library

### Node.js compatibility is on by default — but Nitro opts out of half of it

Cloudflare: for compatibility dates of **2026-08-04 or later**, both `nodejs_compat` and
`nodejs_compat_v2` are enabled by default with no flag. Between `2024-09-23` and `2026-08-03`,
`nodejs_compat` must be set explicitly and auto-activates v2.

- Sources: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>,
  <https://developers.cloudflare.com/workers/configuration/compatibility-flags/>,
  <https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/>

**Caveat that applies to this stack specifically.** Nuxt 4.5.2 pulls `nitropack ^2.13.4` — the
**Nitro 2** line, not Nitro 3. Nitro's Cloudflare preset writes `nodejs_compat` **and
`no_nodejs_compat_v2`** into the generated `wrangler.json`, with a warning in its own source that
`nodejs_compat_v2` "can cause issues with nitro"; Nitro substitutes its own unenv-based workerd
node-compat plugin instead. So **the Cloudflare compatibility table does not fully describe what our
bundle gets.** Any Node-flavoured dependency in the auth path must be smoke-tested under
`wrangler dev`, not assumed from the compat matrix.

(Also on the Nitro 2 line: bindings are `event.context.cloudflare.env` inside a `defineEventHandler`,
**not** the `event.req.runtime.cloudflare.env` shown on nitro.build, which documents Nitro 3. And
`nitro-cloudflare-dev` is deprecated — its README states it "is no longer required for the latest
versions of Nitro".)

`node:crypto` itself: **"All `node:crypto` APIs are fully supported in Workers"**, with explicit
exceptions — DSA/DH key pairs, **`argon2` / `argon2Sync`**, ed448, and x448.

- Source: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/>

Consequences:

- `scrypt` / `scryptSync`, `pbkdf2`, `randomBytes`, `timingSafeEqual`, `createHash` are available.
- **argon2 is not.** Any plan that says "swap to argon2id on Workers" is dead on arrival. scrypt is
  the right choice, and happens to be Better Auth's default.
- **workerd caps KDF work regardless of `cpu_ms`.** `checkPbkdfLimits` / `checkScryptLimits` in
  `src/workerd/api/crypto/impl.c++` reject PBKDF2 above 100,000 iterations with
  `DOMNotSupportedError`, and impose a scrypt cost cap. OWASP wants 600k (SHA-256) PBKDF2
  iterations; that is unreachable on Workers. Open since 2023-10-25, unassigned:
  <https://github.com/cloudflare/workerd/issues/1346>. This is a point in scrypt's favour, not
  against it — but it means the KDF parameters are not freely tunable and must be verified rather
  than assumed. Related: <https://github.com/cloudflare/workerd/issues/6639> (scrypt `maxmem`
  mismatch).

### CPU time is the real constraint, and it decides the billing plan

Workers limits:

- **Free plan: 10 ms CPU per request.**
- **Paid plan: 30 s default, configurable to 5 min (300,000 ms) via `limits.cpu_ms`.**
- Exceeding it returns Error 1102, "Worker exceeded resource limits".

- Source: <https://developers.cloudflare.com/workers/platform/limits/>

### The scrypt trap is real, and the fix is a version pin

This is the single most important operational finding in this document, and it is not something you
would discover from any marketing page.

Better Auth issue [#8860](https://github.com/better-auth/better-auth/issues/8860) — *"email/password
sign-up exceeds CPU time limit on Cloudflare Workers"*, opened 2026-03-31, closed 2026-04-01 —
documents pure-JS `@noble/hashes` scrypt at `N=16384, r=16, p=1` burning **~4.5–5 s of CPU** on
Workers, hitting `exceededCpu`.

The root cause is subtle and worth stating precisely: `@better-auth/utils` shipped a **`node`**
export condition but **no `workerd` condition**. Wrangler resolves `workerd` first, so Workers fell
through to the pure-JS fallback **even with `nodejs_compat` enabled**. `password.ts` on `main` still
describes only the `node` condition:

```
/**
 * `@better-auth/utils/password` uses the "node" export condition in package.json
 * to automatically pick the right implementation:
 *   - Node.js / Bun / Deno → `node:crypto scrypt` (libuv thread pool, non-blocking)
 *   - Unsupported runtimes → `@noble/hashes scrypt` (pure JS fallback)
 */
```

- Source: <https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/crypto/password.ts>
- Driving issue: [#8456](https://github.com/better-auth/better-auth/issues/8456), closed 2026-03-09.
- Follow-up: [#9649](https://github.com/better-auth/better-auth/issues/9649).

**Fixed in `@better-auth/utils@0.4.1`**, which adds the `workerd` condition.
`better-auth@1.7.3` pins `@better-auth/utils@0.4.2` (verified against
<https://unpkg.com/@better-auth/utils@0.4.2/package.json>).

**Therefore: pin `better-auth` ≥ 1.7.3 and add a CI assertion that the resolved
`@better-auth/utils` is ≥ 0.4.1.** A transitive downgrade reintroduces a 5-second sign-in with no
error message and no test failure — it just gets slow, then starts throwing 1102s under load. This
is exactly the class of regression a lockfile drifts into silently.

Two further notes on parameters: `r=16` implies roughly 33 MB of memory per hash against a 128 MB
isolate, and it sits near workerd's scrypt cost cap (see above). **Spike task: sign in once on a
deployed preview and read the actual CPU time from Workers Logs.** If the native path is not being
taken, the documented workaround is to override `emailAndPassword.password.hash` / `.verify` with
`node:crypto` `scryptSync` at the same `N=16384, r=16, p=1`, which keeps existing hashes compatible.

Mitigating factor for shop-keepr specifically: with a **single shared store login**, password hashing
runs on sign-in only — a handful of times a day, not per request. Even a mediocre path is tolerable
here. But it still rules the Free plan out, and the version pin is still mandatory.

### Bindings at module scope

Better Auth wants a database handle when the `auth` object is constructed. Cloudflare documents
`import { env } from "cloudflare:workers"` for exactly this: *"Importing `env` from
`cloudflare:workers` is useful when you need to access a binding such as secrets or environment
variables in top-level global scope."* The caveat — *"Workers do not allow I/O from outside a
request context"* — does not bite, because constructing the adapter performs no I/O.

- Source: <https://developers.cloudflare.com/workers/runtime-apis/bindings/>

Prefer the `cloudflare:workers` import for the `auth` singleton, and `event.context.cloudflare.env`
inside `defineEventHandler` for request work (Nitro 2 — see the Nitro-version caveat above).

### Workers KV is disqualified for sessions

If sessions live in KV, revocation is not immediate — and the usual "up to 60 seconds" summary is
understated. Cloudflare's exact wording is that changes *"may take up to 60 seconds **or more** to be
visible in other global network locations"*, where 60 s is merely the **default `cacheTtl`** — tuning
`cacheTtl` up for performance lengthens the window. There is not even a read-your-writes guarantee at
the writing location: *"At the … location at which changes are made, these changes are usually
immediately visible. However, this is not guaranteed and therefore it is not advised to rely on this
behaviour."* KV is also *"not ideal for applications where you need support for atomic operations"*
and is limited to 1 write/sec per key.

- Sources: <https://developers.cloudflare.com/kv/concepts/how-kv-works/>,
  <https://developers.cloudflare.com/kv/platform/limits/>

Session revocation matters for this app, so **sessions stay in the primary database**, not in KV
secondary storage. That is Better Auth's default anyway; the point is not to "optimise" it into KV
later.

Related nuance for the #2 thread: **D1 without read replication is single-primary and strongly
consistent.** With replication enabled you get documented read-your-own-writes and monotonic reads
*only* if queries route through a single `withSession()` handle — which a general-purpose auth
library will not do for you. If #2 turns on D1 read replication, keep the auth tables off it, or
accept the same staleness class as KV.

- Source: <https://developers.cloudflare.com/d1/best-practices/read-replication/>

---

## 2. Better Auth on Workers

Current release line is **1.7.x** (docs index: <https://better-auth.com/docs/llms.txt>). 1.5,
released 2026-02-28, was the release that hardened the Workers path — its notes cite fixed
"immutable headers handling on Cloudflare Workers" and "improved cookie injection for edge
environments".

- Source: <https://better-auth.com/blog/1-5>

### D1 works, and is documented first-party

Better Auth's own database docs carry a Cloudflare D1 example that passes the binding straight in:

```ts
import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  database: env.DB,
  // ... rest of config
});
```

Because the CLI cannot reach D1 (*"Cloudflare D1 can only be queried through a Cloudflare Worker,
so the CLI cannot access it directly"*), schema is applied with **programmatic migrations**:

```ts
import { getMigrations } from "better-auth/db/migration";
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
await runMigrations();
```

Documented constraint: **`getMigrations` only works with the built-in Kysely adapter (SQLite/D1,
PostgreSQL, MySQL, MSSQL). It does not work with Prisma or Drizzle ORM adapters** — with Drizzle you
use CLI migrations instead.

- Source: <https://better-auth.com/docs/concepts/database>

D1 also has no interactive transactions; Better Auth's D1 path uses D1's `batch()` API for atomicity
(`transaction = false` in `packages/kysely-adapter/src/dialect.ts`). Only features that genuinely
require native transactions break — SCIM is the documented casualty
([#10860](https://github.com/better-auth/better-auth/issues/10860), open), and shop-keepr will never
want SCIM.

- Source: <https://better-auth.com/blog/1-5>

### Do not use the Drizzle adapter for the auth tables on D1

The ticket framed Better Auth as "self-hosted, **Drizzle adapter**". On D1 that combination is
currently broken, and there is no configuration escape hatch.

[**#10816**](https://github.com/better-auth/better-auth/issues/10816) (open): the Drizzle adapter
never sets `supportsDates`, and the adapter factory defaults it to `true`. A raw `Date` therefore
reaches D1, which rejects it with `D1_TYPE_ERROR: Type 'object' not supported`. Symptoms are sign-up
422s, social-login 500s and session-refresh 500s. The Kysely adapter handles this correctly
(`supportsDates: false` for SQLite); `DrizzleAdapterConfig` exposes no override.

**So: auth tables use Better Auth's built-in D1/Kysely path (`database: env.DB`).** Drizzle remains
perfectly fine for the *application* schema — inventory, movements, baskets, holds. Two query layers
against one D1 database is not a problem; they touch disjoint tables and never need a join beyond an
opaque `actorUserId`. It is a smaller cost than it first sounds, and it buys the first-party,
documented path.

### Known-open Workers issues worth carrying into the build

None of these are blockers, but a build session that meets one cold will lose a day.

- [**#10315**](https://github.com/better-auth/better-auth/issues/10315) (open, `core`) — **the one to
  actually worry about.** Promises created during a request belong to that request's IoContext. If
  the client aborts, workerd never settles them — and Better Auth caches such promises across
  requests (`ensureAsyncStorage` awaiting a module-level `import("node:async_hooks")`, and
  `$context`). The result is a **poisoned isolate**: every subsequent Better Auth call hangs forever,
  with no error and no timeout, until the isolate recycles. Diagnosed in production; the trigger is
  superseded aborts of in-flight authenticated fetches — which is exactly what a kiosk search-as-you-
  type box generates. **Mitigation: eagerly initialise `auth.$context` at module scope.** Do this
  from day one; it is one line.
- [#10888](https://github.com/better-auth/better-auth/issues/10888) (open) — `@better-auth/mcp`
  `requireMcpAuth` 500s on Workers when the auth server and MCP resource server share one Worker
  (self-fetch of `jwksUrl`). Not relevant unless shop-keepr grows an MCP surface; note it if it does.
- [#10343](https://github.com/better-auth/better-auth/issues/10343) (open) — SAML crypto is not
  viable on edge runtimes. Irrelevant here, but it is the shape of thing that would bite an
  enterprise-SSO pivot.
- [#10865](https://github.com/better-auth/better-auth/issues/10865) (open) — the Organization plugin
  bundles every Zod locale, inflating the Worker bundle. Only matters when the per-staff migration
  actually adopts that plugin; watch the bundle-size budget then.

Encouraging counter-signal: the maintainers **do** respond to Workers-specific reports. #9983 (eager
`createRequire(import.meta.url)` crashing Workers on 1.7.0-beta.4), #10052 (SSO discovery failing
because workerd does not support `redirect: "error"`), #9649, #8860, #10103 and #10832 are all fixed.
Workers is a runtime this project treats as supported, not a runtime it tolerates.

### Nuxt is a first-class integration

Official page. Mount a catch-all Nitro route:

```ts
// server/api/auth/[...all].ts
import { auth } from "~~/lib/auth";
export default defineEventHandler(event => auth.handler(toWebRequest(event)));
```

Client side uses `better-auth/vue`, and `authClient.useSession(useFetch)` for SSR-safe session
loading. Nothing here is Node-specific; it is a Web `Request` in, a Web `Response` out, which is
precisely what a Worker handles.

- Source: <https://better-auth.com/docs/integrations/nuxt>

### Sessions are DB-backed and revocable

Default model: sessions in the `session` table, 7-day `expiresIn`, `updateAge` 1 day. Revocation
API: `revokeSession(token)`, `revokeOtherSessions()`, `revokeSessions()`, plus
`changePassword({ revokeOtherSessions: true })`.

The one trap, quoted from the docs:

> When `cookieCache` is enabled, revoked sessions may remain active on other devices until the
> cookie cache expires (`maxAge`) […] **If immediate session revocation is critical:** Disable
> `cookieCache` entirely, or set a shorter `maxAge` (e.g. 60 seconds), or use
> `disableCookieCache: true` for sensitive operations.

Better Auth also supports fully **stateless** sessions (signed/encrypted cookie, no DB). That is the
option the ticket asked us to challenge — and the challenge fails: stateless means no revocation.
For a shared store password that will eventually be typed in front of customers and known by
ex-staff, revocation is the whole point.

- Source: <https://better-auth.com/docs/concepts/session-management>

**Decision: DB-backed sessions, `cookieCache` disabled.** The store has a handful of concurrent
staff sessions; one extra D1 read per request is free at this scale. Revisit only if D1 read volume
ever shows up in a bill.

### Password hashing

> **Password Hashing**: Better Auth uses `scrypt` to hash passwords. […] OWASP recommends using
> `scrypt` if `argon2id` is not available. We decided to use `scrypt` because it's natively
> supported by Node.js.

Convenient: argon2 is one of the few `node:crypto` gaps on Workers, so the default is also the only
good option here.

- Source: <https://better-auth.com/docs/authentication/email-password>

### The API Key plugin covers the kiosk

Shipped as its own package, `@better-auth/api-key`, since 1.5. Relevant capabilities, all documented:

| Need | API Key plugin |
|---|---|
| Long-lived | `expiresIn` in seconds, or omitted for no expiry |
| Revocable | `auth.api.deleteApiKey()`, `updateApiKey({ enabled: false })` |
| Scoped | `permissions: Record<string, string[]>` on the key; `verifyApiKey({ key, permissions })` checks them |
| Usage caps | `remaining` / `refillInterval` / `refillAmount`; key auto-disabled at 0 |
| Rate limited | `rateLimitEnabled`, `rateLimitTimeWindow`, `rateLimitMax` |
| Labelled per device | `metadata` |
| Not in a header | `customAPIKeyGetter(ctx)` — return the key from anywhere on the request, **including a cookie** |
| Acts as a session | `enableSessionForAPIKeys: true` synthesises a session from a user-owned key |

Sources:
- <https://better-auth.com/docs/plugins/api-key>
- <https://better-auth.com/docs/plugins/api-key/advanced>
- <https://better-auth.com/docs/plugins/api-key/reference>

Note the docs' own warning on `enableSessionForAPIKeys`: *"This is generally not recommended, as it
can lead to security issues if not used carefully. A leaked api key can be used to impersonate a
user."* That warning is about keys that map to a **human** user. Here the key maps to a purpose-built
kiosk principal that can do only two things, so the blast radius of a leak is the blast radius of a
kiosk — which is the design goal, not a flaw. Enable it only if the ergonomics are worth it;
`verifyApiKey` in a route middleware is the more conservative path and is preferred (see below).

### Path from shared login to per-staff users

This is where self-hosting pays. The shared login is **one row in `user`**. Going per-staff is:

1. Create a `user` row per staff member (Admin plugin: `auth.api.createUser`).
2. `revokeSessions()` on the shared account, delete it.
3. Backfill `userId` on historical movements to a "Store (shared login)" sentinel user.

No data migration off a vendor, no re-platforming. The **Organization plugin** (teams, roles,
`membershipLimit`, org-owned API keys) and the **Admin plugin** (impersonation, ban, user CRUD) are
drop-in later, and the Organization plugin is also the natural home for `storeId` if multi-store ever
becomes a product surface rather than a column.

Sources: <https://better-auth.com/docs/plugins/organization>, <https://better-auth.com/docs/plugins/admin>

**Audit-field consequence for the movement ledger** (feeds the map's open "migration path" item):
put a nullable `actorUserId` on every Movement **now**, pointing at the shared user. It costs nothing
today and it is the difference between a clean split later and an unattributable ledger.

---

## 3. Cloudflare Access — good tool, wrong job

Access can front a Worker on a custom domain and is genuinely strong for an internal-only app. But
for this app, in this MVP:

**It cannot serve the kiosk.** The kiosk is a public surface on the same hostname. Serving it means a
**Bypass** policy on the kiosk paths, and Cloudflare is blunt about what Bypass costs:
*"The Bypass action in Cloudflare Access disables Access enforcement for specific traffic […] Bypass
does not enforce any Access security controls and requests are not logged."*

- Source: <https://developers.cloudflare.com/cloudflare-one/policies/access/>

So Access gives the kiosk nothing, and the app still has to authenticate kiosk requests itself.

**The app must validate the JWT anyway.** Cloudflare: *"You should validate the token with your
public key to ensure that the request came from Access and not a malicious third party."* Validate
the `Cf-Access-Jwt-Assertion` header (recommended over the `CF_Authorization` cookie, *"since the
cookie is not guaranteed to be passed"*) against
`https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`.

- Source: <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/>

That is JWT-verification code plus a second identity system, on top of the auth the kiosk forces you
to build anyway.

**It fits the shared-login model badly.** Access authenticates *people* by email through an IdP. A
single shared credential is the thing Access is designed to eliminate. Service tokens exist for
machine traffic (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers) but are explicitly
machine-to-machine credentials, not browser session credentials — putting one in a kiosk browser is
the same mistake as a bearer token in `localStorage`, with a longer-lived secret.

**Verdict: not now; revisit at per-staff.** Once staff have individual emails, layering Access over
`/admin` paths is cheap defence-in-depth and gives device posture and audit logging for free. It is
additive to Better Auth, never a replacement.

---

## 4. Clerk and WorkOS

Both are competent and both would work. Neither is worth it here.

### Clerk

- `@clerk/backend` targets V8 isolates including Cloudflare Workers, and there is an official
  `@clerk/nuxt` module. Sources: <https://clerk.com/docs/reference/nuxt/overview>,
  <https://clerk.com/docs/guides/development/sdk-development/backend-only>
- Pricing: Hobby free to **50,000 MRU**; Pro **$25/mo** ($20 annual) then $0.02/user. **Machine
  authentication** (API keys and M2M tokens) is a real product: Hobby includes 1,000 API-key
  creations + 100,000 verifications/mo, and 2,500 M2M token creations + 100,000 verifications/mo;
  overage $0.001 per creation, $0.00001 per verification.
  Source: <https://clerk.com/pricing>
- So Clerk covers **both** identities and, at one shared login plus one kiosk, would sit inside the
  free tier indefinitely.

Against it: session verification is JWT-based, so **revocation is not immediate** — the short-lived
token stays valid until it expires unless you pay a network round trip per request. The user list
lives at Clerk. And "per-staff users come free later" is worth less than it sounds, because Better
Auth's Organization and Admin plugins are also free and already in the same database as the ledger,
where the audit joins need them.

### WorkOS

- AuthKit is **free to 1M MAU**, then $2,500 per additional 1M. SSO is priced per connection
  ($125 down to $65). Source: <https://workos.com/pricing>
- M2M exists as **M2M Applications** using the `client_credentials` flow: *"Instead of having a
  static long-lived secret, your customer uses their client ID and client secret to request
  short-lived access tokens (JWTs) from WorkOS,"* validated against your environment's JWKS.
  Source: <https://workos.com/docs/authkit/connect/m2m>

Against it for the kiosk specifically: `client_credentials` requires the kiosk to hold a
**client secret** and exchange it for tokens. A client secret on a public touchscreen is worse than
a scoped, revocable, single-purpose API key — it is a credential that can mint credentials.

### Shared objection to both

The hosted case is strongest when you need SSO, SCIM, MFA, social login and enterprise directory
sync. shop-keepr needs **one password** and **one device credential**. Both vendors also add an
external dependency to the login path of a tool whose stated failure mode is already "internet down
means the tool is down" — but there is a difference between depending on Cloudflare (which you
already are, totally) and depending on Cloudflare *and* a second SaaS.

---

## 5. Challenging the proposed kiosk shape

The ticket proposed: *a long-lived device token provisioned once by staff, with kiosk endpoints as a
narrow separate API surface.* Two halves, and they deserve different verdicts.

### The narrow separate API surface: keep it, it is the actual security control

The credential says *who*; the surface says *what*. Get the surface right and a leaked kiosk token is
a nuisance rather than an incident.

- `/api/kiosk/**` — accepts **only** a kiosk credential. Rejects staff sessions too; a bug that
  routes a staff request here should fail loudly, not silently succeed.
- `/api/admin/**` — accepts **only** a staff session.
- Deny by default. A new route is unreachable until it is explicitly placed in a surface.
- **Enforce shape at the query layer, not just the route.** The kiosk must not be able to read cost
  price, margin, buy-in history or supplier data. Give the kiosk surface its own read functions that
  select an explicit column list. A route guard that hands the kiosk the same rich Inventory Item
  object staff see is one careless serialiser away from leaking margins onto a public screen.
- Kiosk writes are exactly two verbs: create Basket, add/remove line on **its own** Basket. Not
  "write to the Basket table".

### The long-lived device token: keep the idea, fix the delivery

**Do not hand the token to kiosk JavaScript.** The threat model is a customer standing at the screen
with as much time as they like. Anything reachable from `localStorage`, `sessionStorage` or a JS
variable is reachable by anyone who opens devtools, plugs in a keyboard, or exits kiosk mode.

Instead, provision it as a **cookie the page can never read**:

1. Staff, authenticated in the internal UI, click "Enrol this device". The server creates an API key
   (`auth.api.createApiKey`) with `permissions: { basket: ["create"], inventory: ["read"] }`,
   `metadata: { deviceName, enrolledBy, enrolledAt }`, and a long `expiresIn`.
2. Enrolment produces a **single-use, short-TTL enrolment code** shown on the staff screen. Staff
   type it into the kiosk once.
3. The kiosk posts the code; the server sets the API key as a cookie:
   `HttpOnly; Secure; SameSite=Lax; Path=/api/kiosk; Max-Age=<long>`. The plaintext key is written
   to a `Set-Cookie` header and never appears in a response body or in JS.
4. Kiosk requests carry it automatically. A `customAPIKeyGetter(ctx)` reads it off the cookie
   instead of the `x-api-key` header — a documented extension point.

This gets you everything the header-token shape gave, and additionally: not readable by page script,
scoped by `Path` so it is never sent to `/api/admin`, no token-handling code in the kiosk client at
all.

**Why an API key rather than a long-lived Better Auth session?** Session lifetime
(`expiresIn` / `updateAge`) is configured globally. Making it long enough for a kiosk would make it
too long for staff. API keys carry **per-key** expiry, per-key permissions, per-key rate limits and
per-key usage caps — the right granularity, and revocation is still one DB delete.

**Also specify:**

- **Rotation and re-enrolment.** Enrolment is idempotent per device; re-enrolling issues a new key
  and revokes the old one. Staff need a "revoke this device" button, and a visible list of enrolled
  devices, or revocation will never happen in practice.
- **Rate limit the kiosk surface.** The plugin's `rateLimitMax` / `rateLimitTimeWindow` are the cheap
  version. Basket creation especially: a leaked kiosk key should not be able to mint holds against
  every SKU in the shop and drain available-to-promise. Interacts with issue #1's TTL holds — worth
  a note when hold TTL is specified.
- **Store keys hashed.** The plugin supports hashed storage modes; use one, so a D1 dump is not a
  set of live credentials.
- **The kiosk credential is not a user.** Model it as its own principal. Do not let a kiosk key ever
  satisfy a staff route guard, even accidentally, even in dev.

---

## 6. Compatibility with the open data-layer decision (#2)

Issue #2 is unresolved between D1, Postgres via Hyperdrive, and Durable Object SQLite. **The
recommendation survives all three**, which is the point of choosing a library over a hosted vendor.
Costs differ:

| Data layer | Better Auth verdict | Evidence and cost |
|---|---|---|
| **D1** | ✅ **Best fit — first-party, documented** | `database: env.DB` straight from `cloudflare:workers`; auto-detected by duck-typing `batch`/`exec`/`prepare`. Shipped in 1.5. Migrations run programmatically via `getMigrations` (the CLI cannot reach D1), or generate SQL and `wrangler d1 migrations apply`. No interactive transactions. **Use the built-in Kysely path, not Drizzle** (issue #10816). |
| **Postgres via Hyperdrive** | ⚠️ **Plausible, but nobody has shown it** | PostgreSQL is a core Kysely dialect and Better Auth's Postgres path takes a `pg` Pool, so it *should* compose — but there are **zero** Better Auth docs, examples or issues demonstrating Better Auth + Hyperdrive. It is claimed only by a third-party package. Cloudflare requires `nodejs_compat` and `compatibility_date` ≥ `2024-09-23`; recommended driver is node-postgres (`pg`), with Postgres.js ≥ 3.4.5 and Drizzle ≥ 0.26.2 also listed. Hyperdrive is **free on both plans**, capped at 100,000 queries/day on Free. If #2 picks this, budget a spike. |
| **Durable Object SQLite** | ❌ **Not usable as the auth store** | `ctx.storage.sql` is reachable **only from inside the DO**; `sql.exec()` is synchronous and returns a cursor that must be consumed before the next `await`. Drizzle's DO support (`drizzle-orm/durable-sqlite`) is constructed inside the DO and its docs still reference `drizzle-orm@rc` — release candidate, not stable. There is no Better Auth doc, issue or PR targeting DO SQLite. Reaching it from the Worker means an RPC hop per adapter operation behind a hand-written facade, and funnels all auth through one global DO — a single-threaded chokepoint with a ~1,000 req/s soft limit. |

Sources: <https://developers.cloudflare.com/durable-objects/api/storage-api/>,
<https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/>,
<https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do>,
<https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/>,
<https://developers.cloudflare.com/hyperdrive/platform/pricing/>,
<https://developers.cloudflare.com/hyperdrive/configuration/local-development/>

**Recommended composition, stated plainly:**

- **#2 picks D1** → auth tables in the same D1 database. Cleanest outcome; nothing more to decide.
- **#2 picks Hyperdrive/Postgres** → auth tables in the same Postgres, standard CLI migrations. The
  most boring option and the only one where a stock Postgres adapter drops in unmodified — but spike
  Better Auth + Hyperdrive specifically, because no one has published it working.
- **#2 picks DO SQLite** → **add a small D1 for auth only.** This does **not** block the
  recommendation. Auth data and inventory data have nothing to join on except an opaque
  `actorUserId`, so the split is free; it is one extra binding.

Please carry that last line into the #2 thread: DO SQLite should not be discarded on the false
belief that it forces an auth rewrite, and equally it should not be chosen on the belief that it can
host the auth tables. It can do neither.

**Contrast: the hosted vendors are data-layer-agnostic** because they hold the users themselves.
That is their only genuine advantage in this matrix, and it is the same fact as the lock-in.

---

## 7. What this leaves open

Ordered by how much it would hurt to discover late.

1. **Smoke-test the scrypt path on a deployed preview.** Sign in once, read CPU time from Workers
   Logs. Expect low tens of ms; ~5 s means the `workerd` export condition is not being resolved and
   the `node:crypto` override is required. This is the single spike that most needs doing before the
   auth ticket is estimated.
2. **Eagerly initialise `auth.$context` at module scope** from the first commit, per
   [#10315](https://github.com/better-auth/better-auth/issues/10315). A poisoned isolate presents as
   "the app randomly hangs forever" and will cost days to diagnose after the fact.
3. **Pin the version floor and assert it in CI**: `better-auth` ≥ 1.7.3, resolved
   `@better-auth/utils` ≥ 0.4.1.
4. **Workers Paid plan** — now a hard requirement, not a preference. Needs to be an accepted cost.
5. **`compatibility_date` ≥ `2026-08-04`**, and be aware Nitro 2 writes `no_nodejs_compat_v2` into
   the generated Wrangler config regardless. Belongs with the deployment/environments ticket.
6. **If #2 picks Hyperdrive**, spike Better Auth + Hyperdrive specifically. Nobody has published it
   working; the reasoning that it should work is sound but unproven.
7. **`BETTER_AUTH_SECRET`** via `wrangler secret put`, never in `wrangler.jsonc`.
8. **`actorUserId` on Movement** — decide now. Cheap now, expensive later. Feeds the map's open
   "migration path from shared login to per-staff users" item.
9. **Hold-draining via a leaked kiosk key** — interacts with the holds-TTL ticket. A kiosk key that
   can create unlimited Baskets can zero out available-to-promise across the shop.
10. **Kiosk device management UI** — enrolled-device list with a revoke button. Without it,
    revocation is theoretical.

---

## Sources

Cloudflare:

- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/>
- <https://developers.cloudflare.com/workers/configuration/compatibility-flags/>
- <https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/>
- <https://developers.cloudflare.com/workers/runtime-apis/bindings/>
- <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
- <https://developers.cloudflare.com/kv/platform/limits/>
- <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- <https://developers.cloudflare.com/durable-objects/api/storage-api/>
- <https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/>
- <https://developers.cloudflare.com/durable-objects/platform/limits/>
- <https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/>
- <https://developers.cloudflare.com/hyperdrive/configuration/local-development/>
- <https://developers.cloudflare.com/hyperdrive/platform/pricing/>
- <https://developers.cloudflare.com/cloudflare-one/policies/access/>
- <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/>
- <https://github.com/cloudflare/workerd/issues/1346> (PBKDF2 iteration cap)
- <https://github.com/cloudflare/workerd/issues/6639> (scrypt `maxmem`)

Better Auth:

- <https://better-auth.com/docs/llms.txt> (version index; 1.7.x current)
- <https://better-auth.com/blog/1-5>
- <https://better-auth.com/docs/concepts/database>
- <https://better-auth.com/docs/concepts/session-management>
- <https://better-auth.com/docs/authentication/email-password>
- <https://better-auth.com/docs/integrations/nuxt>
- <https://better-auth.com/docs/plugins/api-key>
- <https://better-auth.com/docs/plugins/api-key/advanced>
- <https://better-auth.com/docs/plugins/organization>
- <https://better-auth.com/docs/plugins/admin>
- <https://github.com/better-auth/better-auth/issues/8860> (scrypt CPU blowout, fixed)
- <https://github.com/better-auth/better-auth/issues/8456> (native `node:crypto` scrypt, fixed)
- <https://github.com/better-auth/better-auth/issues/9649> (follow-up, fixed)
- <https://github.com/better-auth/better-auth/issues/10315> (**open** — poisoned isolate)
- <https://github.com/better-auth/better-auth/issues/10816> (**open** — Drizzle + D1 date bug)
- <https://github.com/better-auth/better-auth/issues/10860> (**open** — SCIM needs transactions)
- <https://github.com/better-auth/better-auth/issues/10865> (**open** — Zod locale bundle bloat)
- <https://github.com/better-auth/better-auth/issues/10888> (**open** — MCP self-fetch on Workers)
- <https://github.com/better-auth/better-auth/issues/10343> (**open** — SAML crypto on edge)
- <https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/crypto/password.ts>
- <https://unpkg.com/@better-auth/utils@0.4.2/package.json> (`workerd` export condition)

Clerk / WorkOS:

- <https://clerk.com/docs/reference/nuxt/overview>
- <https://clerk.com/docs/guides/development/sdk-development/backend-only>
- <https://clerk.com/pricing>
- <https://workos.com/pricing>
- <https://workos.com/docs/authkit/connect/m2m>

Nitro:

- <https://nitro.build/deploy/providers/cloudflare> (documents **Nitro 3**; this project is on the
  Nitro 2 line via `nitropack ^2.13.4` — binding accessors differ, see §1)

### Claims deliberately left unverified

Stated here so nobody later mistakes them for established fact:

- **Better Auth + Hyperdrive** has no primary source showing it working. The reasoning is sound; the
  demonstration does not exist.
- **CPU cost of the *fixed* `node:crypto` scrypt path** at `N=16384, r=16` on Workers is unpublished.
  The ~5 s figure in issue #8860 is for the *broken* pure-JS path. Measure it; do not assume it.
- Whether Nitro 2's `no_nodejs_compat_v2` substitution changes the export-condition resolution that
  the scrypt fix depends on. This is the specific interaction the spike in §7 exists to settle.
