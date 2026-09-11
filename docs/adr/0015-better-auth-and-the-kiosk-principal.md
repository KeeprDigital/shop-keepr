---
status: accepted
---

# Better Auth for both identities; the kiosk is its own principal on its own API surface

Staff sign in with Better Auth email and password against a DB-backed session (`cookieCache` off, so revocation is immediate); the kiosk authenticates with a Better Auth API key, minted by staff through a single-use enrolment code and delivered as an `HttpOnly; Secure; Path=/api/kiosk` device cookie that page script can never read. `/api/kiosk/**` accepts only a kiosk key and `/api/staff/**` only a staff session; kiosk responses use their own schemas with no slot for Market Price, Buy Price or ledger data. Decided in [#3](https://github.com/KeeprDigital/shop-keepr/issues/3); the surface split named in [#9](https://github.com/KeeprDigital/shop-keepr/issues/9).

The surprise this records: **the threat model is a customer at a public touchscreen with unlimited time**, so the security control is the narrowness of the surface, not the strength of the credential. Any token reachable from JavaScript, any shared guard that strips fields by role, and any long-lived session on the kiosk were rejected on that basis.

## Considered options

**Cloudflare Access as primary** — rejected: it cannot cover the kiosk, a Bypass rule on kiosk paths disables all Access controls and logging, and the app must validate the Access JWT anyway. It may be layered on staff paths later, at per-staff users.

**Clerk** — rejected: JWT sessions with non-immediate revocation; the user list lives off-platform, which is exactly what makes the shared login awkward to split later.

**WorkOS** — rejected: machine-to-machine auth is `client_credentials`, a client secret on a public touchscreen.

**A long-lived Better Auth session for the kiosk** — rejected: session lifetime is global; API keys carry per-key expiry, permissions, rate limit and usage cap.

**Stateless signed-cookie sessions** — rejected: no revocation.

## Consequences

**Better Auth's tables live in the same D1 database via its Kysely/D1 path, not the Drizzle adapter** (the adapter hands raw `Date`s to D1). Migrations run programmatically; the epoch-ms timestamp rule does not extend to these tables.

**Workers Paid is a hard requirement**: the Free plan's CPU budget cannot fit scrypt. CI asserts the resolved `@better-auth/utils` is at least 0.4.1, below which Workers silently falls to pure-JS scrypt at ~5 s per sign-in.

**`auth.$context` is initialised eagerly at module scope** from the first commit; an aborted request otherwise poisons every later auth call in the isolate.

**The path to per-staff users is additive**: create `user` rows, revoke the shared account's sessions, delete it. Ledger entries already carry `session_id` and a nullable `staff_user_id` that backfills.
