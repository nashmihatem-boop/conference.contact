# conference-contact-api

Subscription SaaS backend for conference.contact. NestJS + PostgreSQL (via Prisma) + Redis, designed to sit behind the Astro marketing site as a separate, independently deployable service.

Full architecture rationale (tech choices, security model, deployment plan) lives in the project conversation — this README covers what's actually built and how to run it.

## Status

**Phase 8 complete: background jobs + fraud detection.** Every phase from the original roadmap is now built. What's left is genuinely-later work: an ML-style risk model (current one is a simple explainable point score, deliberately), and anything not already covered below.

Auth (Phase 3):
- ✅ Registration, email verification, login, logout, logout-everywhere
- ✅ Argon2id password hashing, OWASP-baseline params
- ✅ JWT access tokens (15 min) + rotating opaque refresh tokens in an HttpOnly cookie
- ✅ Refresh-token reuse (theft) detection — revokes the whole session family
- ✅ Account lockout after repeated failed logins, per-account and per-IP rate limiting
- ✅ TOTP 2FA (Google Authenticator–compatible): enroll, confirm, disable
- ✅ Device recognition + new-device verification (email code, or TOTP if 2FA is on)
- ✅ Password reset via email, which also revokes existing sessions
- ✅ Multi-device session listing, per-device logout, logout-everywhere
- ✅ Every security-relevant action writes an `AuditLog` row
- ✅ ToS/Privacy consent recorded at registration (`ConsentRecord`)

Billing (Phase 4):
- ✅ Stripe Checkout (subscription mode) — `POST /subscriptions/checkout`
- ✅ Stripe Customer Portal — `POST /subscriptions/portal`
- ✅ Webhook handling with real signature verification (`POST /webhooks/stripe`): `checkout.session.completed`, `customer.subscription.created/updated/resumed/deleted`, `invoice.paid`, `invoice.payment_failed`
- ✅ Refresh-token-reuse-style theft response doesn't apply here, but the equivalent safety property does: a revoked/tampered webhook signature is rejected outright (verified — see below)
- ✅ `SubscriptionGuard` for protecting premium routes (ACTIVE/TRIALING/PAST_DUE all count as "has access" — a failed card charge doesn't cut access instantly; only CANCELED/EXPIRED lock you out). Not yet applied to any route — there's no premium-content endpoint built yet to protect
- ✅ Cancellation (`cancel_at_period_end`, not immediate) with optimistic local update reconciled by the webhook
- ✅ `getOrCreateStripeCustomer` race fixed — see Phase 7/8 section below

Security hardening (Phase 5):
- ✅ CORS fixed — production previously disabled CORS entirely (`origin: false`) instead of restricting it to the frontend origin, which would have silently broken every request from the Astro site. Now uses `FRONTEND_URL` in production, permissive only in development.
- ✅ `POST /auth/devices/:id/trust` no longer leaks `fingerprint` — same class of bug as the `listForUser`/`listActiveForUser` fix, found by re-auditing every endpoint that returns a `Device`/`Session`/`User` object for the same pattern
- ✅ Global exception filter (`AllExceptionsFilter`) — every error response has a consistent shape (`statusCode`, `error`, `message`, `path`, `timestamp`, `requestId`); unhandled (non-`HttpException`) errors are logged in full server-side but reduced to a generic message on the wire, so a stray Prisma error or null-deref never leaks internals (stack traces, DB constraint names, file paths) to a client
- ✅ GDPR data export (`GET /auth/data-export`) — returns everything the account holds (profile, devices, sessions, subscriptions + invoices, consent records, own audit log) in one payload, built the same way as every other client-facing read here: explicit `select`, never a raw model
- ✅ GDPR right-to-erasure (`DELETE /auth/account`) — password-confirmed soft delete (`status: DELETED`, `deletedAt` stamped), cancels any active Stripe subscription immediately (not at period end), revokes every session, clears the refresh cookie. Hard erasure remains a deliberate separate admin/background job, not implemented by this endpoint — see the `deletedAt` comment in `schema.prisma`
- ✅ Re-verified: refresh-token cookie is `httpOnly` + `secure` (prod) + `SameSite=Strict` — already solid CSRF defense, no change needed
- ✅ Full audit pass over every Auth/Billing controller and service method's return value looking for raw-Prisma-object exposure — no further leaks found beyond the one fixed above

Admin API (Phase 6):
- ✅ `GET /admin/users` — paginated, filterable by `status`, `role`, and case-insensitive `search` on email/full name
- ✅ `GET /admin/users/:id` — profile plus device count, active session count, and current subscription summary
- ✅ `POST /admin/users/:id/suspend` / `POST /admin/users/:id/reactivate` — status transitions with state checks (can't suspend a non-ACTIVE account, can't reactivate a non-SUSPENDED one); suspend also revokes every session and records an optional `reason` on the audit entry
- ✅ `POST /admin/users/:id/force-logout` — revokes every session for a user without changing account status
- ✅ `GET /admin/subscriptions` — paginated, filterable by `status`, includes the owning user and plan
- ✅ `GET /admin/audit-logs` — paginated, filterable by `action` (substring), `actorUserId`, `targetId`
- ✅ Every route requires `ADMIN` or `SUPER_ADMIN` (`RolesGuard` + `@Roles()`, checked against the role already embedded in the access token) — verified with three real logged-in identities (unauthenticated → 401, regular `USER` → 403, `ADMIN` → 200)
- ✅ Every admin action writes an `AuditLog` row with the admin as actor and the affected user as target
- ✅ An admin cannot suspend their own account (a lockout-prevention rail, not a permission-model feature)

Background jobs (Phase 7):
- ✅ Email sending moved onto a real BullMQ queue (`EmailService` is now a thin producer; `EmailProcessor` is the worker holding the actual Resend client) — a registration/login/etc. request no longer blocks on Resend's API, and a transient Resend outage is retried (3 attempts, exponential backoff) instead of silently swallowed
- ✅ Stripe webhook processing moved onto its own queue the same way — signature verification stays synchronous (it's the actual authentication for that route and it's cheap), but the real DB-writing work (`handleWebhookEvent`) is queued so Stripe gets a fast response regardless of database latency
- ✅ Failed webhook jobs write a `billing.webhook_processing_failed` audit entry once retries are exhausted (not on every retry — that would just be noise)
- ✅ Graceful shutdown (`setupGracefulShutdown` in `main.ts`) so in-flight jobs get a chance to finish on redeploy, with a 10s hard-timeout fallback — see "Notable implementation decisions" for why the hard timeout isn't optional
- ✅ `app.set('trust proxy', 1)` — found while building this phase, not part of the original ask: without it, `req.ip` (and therefore per-IP rate limiting *and* every geo/risk signal below) would have seen the load balancer's address for every user in production, not the real client IP

Fraud detection (Phase 8):
- ✅ Sessions are geolocated at login (`GeoipService`, offline via `geoip-lite` — no third-party API call, no account/API key needed) and store `country`/`city`/`timezone`
- ✅ `RiskService` computes an explainable point score at login time: new device (+30), country not seen in the user's last 5 sessions (+25), a session from a *different* country within the last hour (+50, "impossible travel"), recent failed login attempts (+5 each, capped at +20)
- ✅ Scores ≥ `RISK_HIGH_THRESHOLD` (default 50) write a distinct `auth.high_risk_login` audit entry, separate from the normal `auth.login` row
- ✅ `GET /admin/security/sessions` — paginated, sorted by risk score, filterable by `minScore` — the API a security dashboard would consume
- ✅ `GET /admin/users/:id/sessions` — one user's full session history with geo + risk detail
- ✅ Verified end-to-end with real IPs (`8.8.8.8` / `1.1.1.1` via `X-Forwarded-For`, only possible once `trust proxy` was fixed): same device + same country scored 0, same device + a country switch within the hour correctly scored 75 and fired both `newCountry` and `impossibleTravel`

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start Postgres

Two options — pick one:

**Option A — Docker** (recommended once you have Docker installed locally; this sandbox didn't have it, so option B is what was actually used to build and verify this project):

```bash
docker compose up -d postgres redis
```

Then set `DATABASE_URL` in `.env` to match `docker-compose.yml`'s credentials (see `.env.example`).

**Option B — Prisma's built-in local dev server** (no Docker required):

```bash
npx prisma dev -d
```

This prints a connection string like `postgres://postgres:postgres@localhost:PORT/template1?sslmode=disable` — put that in `.env` as `DATABASE_URL`. `npx prisma dev stop default` stops it, `npx prisma dev rm default --force` removes it entirely.

### 2b. Start Redis

Backs BullMQ (email + webhook processing) and admin-suspend's instant access-token revocation. Same two options as Postgres:

**Option A — Docker/Homebrew**, if you have either: `docker compose up -d redis` or `brew services start redis`, then `REDIS_URL="redis://localhost:6379"` in `.env`.

**Option B — no Docker/Homebrew** (what this sandbox used, since it had neither): `node scripts/dev-start-redis.mjs` spins up a real Redis server via the `redis-memory-server` package (downloads and runs an actual `redis-server` binary, the same idea as `npx prisma dev` for Postgres — not a mock). It prints the connection string to use as `REDIS_URL`.

The app fails open if Redis becomes unreachable after startup (see "Notable implementation decisions"), but it still needs to be up to boot — `REDIS_URL` is a required, Joi-validated env var.

### 3. Configure environment

```bash
cp .env.example .env
```

Then fill in every value `.env.example` documents — `JWT_ACCESS_SECRET` and `TWO_FACTOR_ENCRYPTION_KEY` each have a one-line `node -e ...` generator command in the comments above them. You'll also need a free [resend.com](https://resend.com) API key for `RESEND_API_KEY`, and a **test-mode** Stripe key (`sk_test_...`) for `STRIPE_SECRET_KEY` — see below.

**Use a Stripe account dedicated to this product**, not one shared with an unrelated business — different statement descriptor, isolated dispute/risk history, and this app's webhook only needs to see this product's events. Test mode is available immediately on a new account, before any live/business verification is complete.

`STRIPE_WEBHOOK_SECRET` can be anything locally if you're only testing signature-verification/sync logic with self-signed payloads (see `scripts/create-stripe-plan.ts` era testing in the project history) — the real value comes from the Stripe dashboard's webhook endpoint config, or `stripe listen --print-secret` if you have the Stripe CLI, once you're testing against real webhook delivery.

### 4. Run migrations

```bash
npx prisma migrate dev
```

If you hit `Error: P3006 ... type "X" already exists` against a `prisma dev` instance, that's a shadow-database quirk with this local dev server, not a real migration conflict — see "Notable implementation decisions" below.

### 5. Create and seed a plan

```bash
npx tsx scripts/create-stripe-plan.ts   # creates a real Stripe Product + Price (test mode), prints the price ID
# paste that price ID into scripts/seed-plans.ts, then:
npx tsx scripts/seed-plans.ts           # upserts the local Plan row to match
```

Currently seeds a single "Full Access" $200/month plan, matching what's live on the Astro frontend's pricing page.

### 6. Start the API

```bash
npm run start:dev
```

- API: `http://localhost:3000/api/v1`
- Swagger docs (non-production only): `http://localhost:3000/api/docs`
- Health check (no auth required): `GET /api/v1`

## Verifying it works

```bash
npx tsx -r dotenv/config scripts/smoke-test.ts                # database layer: create/query/constraint checks
npx tsx -r dotenv/config scripts/check-audit.ts [prefix]       # dumps recent AuditLog rows, optionally filtered (e.g. "billing.")
npx tsx -r dotenv/config scripts/check-subscription.ts <email> # dumps a user's subscriptions + invoices
npx tsx -r dotenv/config scripts/check-sessions.ts <email>     # dumps a user's sessions with geo + risk detail
```

The full auth flow (register → verify email → login → new-device challenge → 2FA enrollment → refresh rotation → theft detection → password reset → lockout → rate limiting) was verified end-to-end over real HTTP during development, including a real email round-trip via Resend and real TOTP codes generated from the enrollment secret.

The full billing flow was verified against the real Stripe test API, not mocked: a real customer and checkout session were created, a real subscription was created and its payment confirmed with Stripe's test card token (`pm_card_visa`), and the resulting real Stripe objects (subscription, invoice) were wrapped in self-signed webhook events — signed with the exact HMAC scheme Stripe uses — and POSTed to the actual `/webhooks/stripe` endpoint. This exercises the real signature verification and sync logic without needing a publicly reachable URL for Stripe to deliver to. A tampered signature was also confirmed rejected (400). Neither flow is captured as an automated integration test yet — see the Jest/Prisma WASM limitation below.

The GDPR endpoints and exception filter were also verified over real HTTP against a running server and database: registered and logged in a real user, confirmed `GET /auth/data-export` returns no sensitive fields (`passwordHash`, `twoFactorSecret`, `tokenHash`, `fingerprint`), confirmed `DELETE /auth/account` rejects a wrong password (401) before accepting the correct one, then confirmed in the database that `status`/`deletedAt` were set and the session was revoked, that the refresh cookie was cleared in the response, and that a subsequent login attempt was rejected with "This account is not active." A request to an unknown route was used to confirm the exception filter's shape and `x-request-id` header on an unhandled-by-any-controller case.

The admin API was verified the same way, with two real logged-in users (one promoted to `ADMIN` directly via Prisma — see the note below on why there's no self-service promotion endpoint): confirmed the three-tier authorization boundary (no token → 401, `USER` role → 403, `ADMIN` role → 200), confirmed `search`/`status` filtering and pagination (`page`/`pageSize`, including the 100-item cap rejecting `pageSize=500`), confirmed the full suspend → reactivate → force-logout lifecycle including its state-check errors (can't suspend an already-suspended account, can't reactivate a non-suspended one, can't suspend yourself, 404 on a nonexistent user), confirmed the suspended user's refresh/login was actually blocked ("This account is not active"), and confirmed every admin action produced the expected `AuditLog` row queryable via `GET /admin/audit-logs?action=admin.`.

Background jobs and fraud detection (Phases 7–8) were verified against a real Redis (`redis-memory-server`, not a mock), a real running server, and real Resend/Stripe calls:
- A registration's email job was confirmed to actually reach `completed` state in the queue (`Queue.getJobCounts()`/`getJobs()`), not just "the endpoint returned 200."
- A self-signed webhook event was confirmed to hit the endpoint fast (~13ms) and complete asynchronously via the queue, separately from the HTTP response.
- Retry/backoff was verified for real: a job that genuinely fails (invalid email address; a Stripe subscription ID that doesn't exist) retries the configured number of times with the configured exponential delays, confirmed by timestamps in the logs, and the webhook queue's final-failure audit entry was confirmed to appear only after the last retry, not on every attempt.
- Impossible-travel detection was verified with real IPs via `X-Forwarded-For` (`8.8.8.8` → US, `1.1.1.1` → AU): the same device logging in again from the same country scored 0 risk with no challenge; the same device switching country within the hour scored 75, correctly firing both `newCountry` and `impossibleTravel` signals, and produced a queryable `auth.high_risk_login` audit row and a `GET /admin/security/sessions` entry.
- The admin-suspend instant-revocation fix was verified by capturing a real access token, confirming it worked (200), suspending that user via the admin API, and confirming the *same, still-unexpired* token was immediately rejected (401 "Access has been revoked") on the very next request — not just eventually, at natural expiry.
- The `getOrCreateStripeCustomer` race fix was verified by firing two genuinely concurrent `POST /subscriptions/checkout` requests for the same brand-new user: both succeeded, exactly one `stripeCustomerId` was persisted, the race was confirmed to actually occur (a `Lost a getOrCreateStripeCustomer race` warning was logged), and both resulting Stripe Checkout Sessions were confirmed — by querying Stripe directly — to reference the same winning customer.
- The bounded-shutdown fix (below) was verified by killing Redis, then sending the running process a real `SIGTERM`: it exited in exactly 10s (the hard-timeout fallback) rather than hanging indefinitely, which is what happened before the fix — confirmed directly, not assumed, since the hang was first discovered by hitting it during this same testing pass. With Redis healthy, the same `SIGTERM` exits cleanly in about 1s.
- The fail-open behavior for the access-token revocation check was verified by killing Redis and confirming an authenticated request that doesn't touch anything suspended still returns 200 (not 500), with a clear `Redis unavailable ... failing open` line in the logs.

## How authentication actually works

**Tokens.** Access tokens are short-lived JWTs (15 min, `JWT_ACCESS_EXPIRY_SECONDS`) sent as `Authorization: Bearer`. Refresh tokens are opaque random values (not JWTs) in an HttpOnly, `SameSite=Strict` cookie scoped to `/api/v1/auth` — only the SHA-256 hash is ever stored, so a stolen database dump contains nothing replayable. Presenting an already-revoked refresh token is treated as a theft signal: the entire session family for that user is revoked immediately (verified in testing — see `AuthService.refresh`).

**Devices.** A first-party `ccdid` cookie (1 year, HttpOnly) identifies the browser across sessions. The first time a given (user, device) pair is seen, the login pauses with a verification challenge — a 6-digit emailed code, or a TOTP prompt if 2FA is already enabled — before any tokens are issued. The challenge itself is a short-lived signed JWT (`type: 'login_challenge'`) carrying the code's hash, not a database row, so there's no extra table for something that expires in 10 minutes anyway.

**Routes are protected by default.** `JwtAuthGuard` is global; anything that should be reachable without a token needs an explicit `@Public()` decorator (registration, login, refresh, the health check, etc.). This is deliberate — a forgotten `@UseGuards()` on a new sensitive route is a much more common real-world bug than a forgotten `@Public()` on a route that should have stayed open, and the latter fails loudly (401) rather than silently.

**Account deletion requires the current password**, the same confirmation `disable2fa` uses — an access token alone (which could be a stolen/short-lived bearer token from a compromised client) isn't enough to destroy the account. It's also rate-limited tighter than most authenticated routes (3/min) since it's the single most destructive action a user can take on their own account.

**Errors never leak internals.** `AllExceptionsFilter` (global, registered via `APP_FILTER`) catches everything, not just `HttpException` — a Prisma error, a null-deref, anything unhandled gets logged in full server-side (keyed by a `requestId` that's also returned to the client in the response body and an `x-request-id` header) but reduced to a generic "Something went wrong" message on the wire. `HttpException`s (validation errors, `UnauthorizedException`, etc.) keep their intended message, since those were already chosen deliberately as safe to show.

## How billing actually works

**One Stripe Customer per User, not per Subscription.** Created lazily on first checkout (`stripeCustomerId` on `User`) and reused for the account's whole lifetime, so cancel-then-resubscribe keeps payment history and saved cards instead of starting over with a fresh Stripe identity.

**Stripe is the source of truth; the local `Subscription`/`Invoice` tables are a fast queryable cache.** Nothing in this app ever decides a subscription is active on its own — `createCheckoutSession` creates a Checkout Session and returns its URL, and the actual `Subscription` row is only ever created or updated by a verified webhook event (`syncSubscriptionFromStripe`). If a webhook is missed or delayed, the local row is stale until the next event arrives — this is the standard, correct trade-off for this integration pattern, not a bug to route around with client-side polling.

**Cancellation is `cancel_at_period_end`, not immediate.** `POST /subscriptions/cancel` tells Stripe to stop renewing, then optimistically flips the local `cancelAtPeriodEnd` flag for instant UI feedback — the webhook reconciles moments later and is the real source of truth if the two ever disagree.

**Refresh-token-reuse has a billing-side analog worth knowing about, but it isn't implemented as one.** A tampered or forged webhook signature is rejected outright (400) before any business logic runs — verified by actually sending one. There's no equivalent to "theft response" here because there's nothing to revoke; an invalid signature just never touches the database.

**`SubscriptionGuard` exists but isn't wired to any route yet.** It's ready to protect whatever premium-content endpoints get built (the actual conference directory search/export API is a separate, later feature), and its logic is unit-tested against all four states (active, past-due grace period, forbidden, unauthenticated) even though no HTTP route exercises it yet.

## How background jobs actually work

**Producers and processors are deliberately separate classes, not one service with an `if (queue) ... else ...` branch.** `EmailService`/`WebhooksController` only ever call `queue.add(...)` — every call site elsewhere in the app that sends an email or handles a webhook didn't need to change at all. `EmailProcessor`/`StripeWebhookProcessor` hold the actual Resend client / call `SubscriptionsService.handleWebhookEvent` and know nothing about HTTP.

**`queue.add()` can hang forever, not just fail, if Redis is unreachable** — confirmed directly (a register request sat with zero response past 8 seconds before this was fixed). BullMQ's Worker connection requires `maxRetriesPerRequest: null` (a hard library requirement), and that setting means a `Queue.add()` call using the same connection retries indefinitely instead of ever rejecting. Every producer call (`EmailService.enqueue`, `WebhooksController.handleStripeWebhook`) is wrapped in a 3-second timeout (`withTimeout`) so a Redis outage becomes a fast, handled failure instead of a silent hang. What happens after the timeout differs deliberately: email enqueue failures are logged and swallowed (the request that triggered them — registration, login — must still succeed, the same resilience property the pre-queue version had for a Resend hiccup), while a webhook enqueue failure becomes a `503` so Stripe's own retry mechanism picks it back up, rather than pretending an event was durably queued when it wasn't.

**Retry/backoff is 3 attempts with exponential backoff (5s, 10s, 20s) by default** (`QueueModule`'s `defaultJobOptions`), tuned down to a 1-hour failed-job retention specifically for the email queue (see below) but left at the global 7-day default for webhooks, where the payload isn't a secret and longer retention is genuinely useful for debugging a real Stripe integration issue.

**Failed email jobs get a much shorter failure-retention window than everything else.** A verification/reset/device-code email job's `data` contains the raw, single-use secret in plaintext — the entire reason it's hashed before it ever reaches the database. The global default keeps a failed job around for 7 days (useful for debugging most failures), which would otherwise mean that same raw secret sits readable in Redis for a week if a send fails. `SHORT_FAILURE_RETENTION` in `email.service.ts` overrides this to 1 hour for exactly these three job types — enough time to notice a failure via the logged error, not long enough to leave a live credential parked far past its own short natural expiry.

**`app.set('trust proxy', 1)` (main.ts) wasn't part of the original plan for this phase — it was found while verifying it.** Without it, `req.ip` is the raw TCP peer address, which in production (behind any reverse proxy — Render/Railway/Fly/nginx, all standard single-hop shapes) means every request looks like it came from the load balancer. That's silently wrong in two places: `ThrottlerGuard`'s per-IP rate limiting would become one shared bucket for every user instead of a per-user one, and every geo/risk signal in Phase 8 would see the same non-public IP for everyone. `1` trusts exactly one hop of `X-Forwarded-For` — correct for a single-reverse-proxy deployment; adjust if the real topology ever has more hops than that.

**Graceful shutdown doesn't use Nest's built-in `app.enableShutdownHooks()`.** That helper `await`s every provider's shutdown hook in sequence and only exits once they've all resolved — if any one hangs, the process never exits, full stop. This isn't theoretical: with Redis down, a dev-watcher-triggered restart left the old process alive and unresponsive on its port for minutes, confirmed by `lsof -i :3000` showing nothing listening and the watcher stuck waiting for a process that would never die on its own. `setupGracefulShutdown` in `main.ts` still runs the same lifecycle hooks (`app.close()` triggers them) but races that against a 10-second hard timeout, after which it force-exits — verified directly: killing Redis and sending a real `SIGTERM` now exits in exactly 10s instead of hanging forever, and with Redis healthy the same signal exits cleanly in about 1s.

## How fraud detection actually works

**Geolocation is offline (`geoip-lite`), not a live third-party API call.** Calling a geolocation API on every login would mean sending every user's real IP address to a third party on every single request — a data-sharing decision with real privacy implications that shouldn't be made silently, on top of being slower and rate-limited. `geoip-lite` bundles its own database and does the lookup locally; no account, no API key, nothing leaves the server. It's less fresh/precise than a paid service like MaxMind GeoIP2 — a reasonable upgrade path later, not needed now for "which country did this login come from."

**Risk scoring is a simple, explainable point score (`RiskService`), not a model.** Every signal — new device, new country, impossible travel, recent failed logins — is something a human reading the audit log or the admin flagged-sessions view can immediately understand and verify. "Impossible travel" specifically is a country-plus-one-hour-window heuristic, not a geographic distance/speed calculation (haversine + a plausible max flight speed); the richer version is a legitimate later upgrade that needs no schema change, this one needs no new infrastructure and already catches the common real case (a session used from a different country shortly after the real login).

**Risk is computed once, at login, and never recomputed.** A refresh-token rotation creates a new `Session` row (for "log out this one device" to keep working per-session) but deliberately doesn't re-run geo lookup or risk scoring — a refresh isn't a new authentication event, so its `country`/`riskScore` stay at the schema defaults (`null`/`0`). Only `AuthService.issueTokenPair` — reached from an actual login, not a refresh — computes and persists them.

**`riskScore`/`riskSignals` are deliberately excluded from user-facing endpoints** (`GET /auth/sessions`, `GET /auth/data-export`) — same reasoning as excluding `fingerprint`/`tokenHash` from those same responses. It's internal security telemetry; showing a user their own risk score would mostly just help someone probing the system learn what does and doesn't trigger detection.

## Notable implementation decisions

- **Prisma 7's client generator emits ESM by default**, which crashes at runtime when required from NestJS's CommonJS build output (`ReferenceError: exports is not defined in ES module scope`). Fixed by setting `moduleFormat = "cjs"` on the `generator client` block in `prisma/schema.prisma`.
- **Prisma 7 requires an explicit driver adapter** (`@prisma/adapter-pg`) rather than the old bundled query engine binary — see `PrismaService`.
- **`npx prisma dev`'s shadow database is fragile across restarts** — after stopping/restarting the same named instance, `prisma migrate dev` can fail with `P3006` even though the main database is fine. Fix used here: `npx prisma dev rm <name> --force` to remove the instance entirely, then `npx prisma dev -d` for a genuinely fresh one, rather than fighting the stale shadow DB. During active schema iteration, `npx prisma db push` (no shadow DB involved) is faster; a proper migration was generated once the schema stabilized.
- **`prisma migrate reset` is blocked for AI agents by Prisma itself** unless the human explicitly consents via a `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` env var containing their literal consent message. This is a deliberate Prisma safety feature, not a bug — respect it if you automate around this project.
- **Billing and audit records are never cascade-deleted.** `Subscription → User`, `Subscription → Plan`, and `Invoice → Subscription` are all `onDelete: Restrict`. Deleting a user with billing history is a deliberate application-level decision (anonymize, not `DELETE`), never an accidental cascade.
- **`Device` and `Session` are separate models.** A `Device` is a recognized browser, persisted independently of any one login. A `Session` is one refresh-token lifecycle, tied to a device. This split exists because "maximum 3 trusted devices" needs to outlive any single login/refresh cycle.
- **Device identity vs. device description are handled separately.** Identity (the fingerprint) comes from the persistent `ccdid` cookie — cheap but honest: if a user clears cookies, the server correctly treats it as unrecognized again. Description (browser/OS shown in the UI) comes from parsing User-Agent via `ua-parser-js`, purely cosmetic, never used to derive identity. Swapping in stronger client-side fingerprinting (e.g. FingerprintJS) later only changes what feeds the identity field — no schema change needed.
- **Refresh tokens are deliberately not JWTs.** JWTs can't be individually revoked without a blocklist; opaque tokens hashed in the database can, which is what makes "log out this one device" and theft detection actually work.
- **The login-challenge token is stateless (signed JWT), but email-verification and password-reset tokens are database-backed (`VerificationToken`).** The challenge only needs to survive ~10 minutes and replaying it isn't meaningfully worse than the underlying compromise; a password-reset link might sit in an inbox for days and needs to be genuinely single-use and revocable (e.g., a second reset request should invalidate the first link) — a pure stateless token can't do that.
- **`JWT_ACCESS_EXPIRY_SECONDS` is a number, not a duration string like `"15m"`.** `@nestjs/jwt`'s newer types want `number | StringValue` where `StringValue` is a branded literal-pattern type a plain runtime string can never satisfy at compile time. Seconds sidestep the mismatch entirely.
- **`otplib` v13 replaced the old `authenticator` object with plain functions** (`generateSecret`, `generateURI`, `verify`) and made `verify` async, returning `{ valid, delta }` instead of a plain boolean. If you're used to v12's API from older tutorials, this is why the code doesn't look like those examples.
- **argon2's TypeScript type is `HashOptions`, not `Options`** (that name doesn't exist in this version), and `hash()` has two overloads — passing `raw: true` returns a `Buffer`, otherwise a `string`. Getting the type annotation wrong silently selects the wrong overload.
- **List endpoints (`GET /auth/devices`, `GET /auth/sessions`) use explicit Prisma `select`, not the default full model.** An early version returned the raw `Device`/`Session` rows, which leaked `fingerprint` and `tokenHash` to the client — hashes aren't reversible, but there's no reason to expose internal security bookkeeping just because it happens to be hashed. Found and fixed during manual testing, not by inspection.
- **A password reset or `logout-all` doesn't retroactively invalidate an already-issued access token.** Access tokens are stateless JWTs by design (that's what makes them fast to verify without a database round-trip); revocation always happens at the refresh-token layer. The practical exposure window is bounded by `JWT_ACCESS_EXPIRY_SECONDS` (15 minutes by default) — worth knowing, not a bug.
- **Emails are normalized to lowercase at the application layer** rather than using Postgres's `citext` extension, to avoid an extra extension dependency for the MVP.
- **Both Jest configs need `moduleNameMapper` mapping `.js` → no extension.** Prisma 7's generated client source uses explicit `.js` extensions on relative imports (standard for `nodenext`-style TypeScript) that Jest's resolver doesn't follow without this mapping.
- **`test/app.e2e-spec.ts` tests `AppController` in isolation, not the full `AppModule`.** Booting the whole module tree pulls in `PrismaModule`, and Prisma 7's WASM query-compiler runtime needs a dynamic `import()` that Jest's default (non-ESM) transform can't execute. Real integration tests against a live database will need either Jest's `--experimental-vm-modules` ESM mode or a different test-runner strategy.
- **Every Stripe `Product` needs a `tax_code`** if the account has Managed Payments enabled (Stripe's merchant-of-record tax/fraud/dispute handling) — Checkout Sessions reject line items from products without one, with a fairly clear error message. `txcd_10103001` ("Software as a service (SaaS) - business use") is what's set on the seeded plan; looked up via `stripe.taxCodes.list()` rather than guessed, since misclassifying a product's tax category is a real compliance question, not a coding detail.
- **`current_period_start`/`current_period_end` are no longer on the root `Subscription` object** in current Stripe API versions (2026-07-29.dahlia here) — they moved to `subscription.items.data[0]`. Similarly, an `Invoice`'s originating subscription is at `invoice.parent.subscription_details.subscription`, not `invoice.subscription`. Both confirmed by reading the installed SDK's actual `.d.ts` files rather than trusting older tutorials/muscle memory — Stripe's API shape has changed meaningfully across versions.
- **Stripe's `pm_card_visa` is a single-use test token, not a reusable payment method ID.** Attaching it to a customer mints a brand-new `PaymentMethod` with its own real ID each time — that returned ID is what has to be reused for `default_payment_method` and `paymentIntents.confirm`, not the literal string `"pm_card_visa"` again. Caused a real `StripeInvalidRequestError` during testing before this was understood.
- **`getStatus()` and `cancel()` must agree on which subscription is "current."** Both query `findFirst` with the same `orderBy: { createdAt: 'desc' }` — in normal operation only one `ACTIVE`/`TRIALING`/`PAST_DUE` row can exist per user (`createCheckoutSession` blocks a second one), but without matching ordering the two methods could silently disagree if that invariant were ever violated (e.g. a subscription created directly via the Stripe dashboard rather than through this app, which is exactly how this was caught during testing).
- **Webhook verification requires the exact raw request body Stripe signed**, not a JSON-parsed-and-restringified copy — they aren't guaranteed to be byte-identical (key ordering, whitespace). `main.ts` disables Nest's automatic body parser and re-registers it manually, with `express.raw()` scoped specifically to `/api/v1/webhooks/stripe` registered *before* the generic `express.json()` for everything else.
- **Account erasure cancels Stripe immediately, not `cancel_at_period_end`.** This is the one place billing cancellation logic is deliberately duplicated rather than reused from `SubscriptionsService.cancel()` — reusing it would have required `AuthModule` to import `SubscriptionsModule`, which already imports `UsersModule` (imported by `AuthModule`), creating a circular module dependency. `AuthService` calls `StripeService` (from `BillingModule`, which has no dependencies of its own) directly instead.
- **GDPR erasure is a soft delete, not a hard one, on purpose.** `Subscription`/`Invoice`/`AuditLog` foreign keys to `User` are `onDelete: Restrict` specifically so billing and audit history is never silently lost to a cascade. `DELETE /auth/account` flips `status` to `DELETED` and stamps `deletedAt`; an actual data-erasure job (scrub or hard-delete the row) is deliberately left as separate, later admin/background work, not bundled into the user-facing endpoint.
- **There's no HTTP endpoint to promote a user to `ADMIN`/`SUPER_ADMIN`.** Bootstrapping the first admin is inherently an out-of-band operation — an endpoint that can mint admins is itself a privilege-escalation target, and there's no "admin zero" to authorize the first one anyway. The first admin is promoted via a direct database write (or a future seed script); this app deliberately never does it over HTTP.
- **`RolesGuard` is applied per-controller (`@UseGuards(RolesGuard)` + `@Roles(...)` on `AdminController`), not global.** Same reasoning as `SubscriptionGuard`: most routes have no role restriction, so making this global would mean every route needs an opt-out instead of the few admin routes needing an opt-in. It reads `role` off the already-verified JWT payload `JwtAuthGuard` attaches — no extra database round-trip per request.
- **Admin suspension, `logout-all`, `resetPassword`, and `deleteAccount` all now invalidate an already-issued access token immediately, not just at its natural expiry.** This used to be a documented gap (stateless JWTs can't be revoked by signature alone) — closed once Redis existed for Phase 7 anyway. `TokenRevocationService` writes a short-TTL key (`revoked:user:<id>`, TTL = `JWT_ACCESS_EXPIRY_SECONDS`) on any of those four actions; `JwtAuthGuard` does one Redis `EXISTS` check per request, after JWT signature verification. Verified directly: captured a working access token, suspended that user via the admin API, and confirmed the *same* token was rejected on the very next request — not eventually, immediately. This is a defense-in-depth layer on top of the primary mechanism (refresh-token revocation, Postgres-backed), not a replacement for it — see the fail-open note below for what happens if Redis itself is the thing that's down.
- **The revocation check fails open, not closed, if Redis is unreachable.** `TokenRevocationService.isRevoked()`/`revokeUser()` both catch their own Redis errors, log loudly, and continue — `isRevoked` returns `false` (treat as not-revoked) rather than rejecting every authenticated request in the app. This was a deliberate design decision, not an oversight: this check is a supplementary layer on top of JWT signature verification, which still holds on its own, and letting a Redis outage take down the *entire* authenticated API surface (every non-public route, not just admin actions) would be a wildly disproportionate availability cost for what's meant to be a narrow security improvement. Verified directly: killed Redis, confirmed an authenticated request still returned 200 with a clear "failing open" line in the logs, rather than 500.

## Known issues tracked, not yet fixed

- `npm audit` flags a high-severity advisory in `js-yaml` (via `@nestjs/swagger`'s dependency tree — a DoS via exponential parsing time on YAML input). This only affects YAML *parsing*, and this project only *generates* OpenAPI JSON from decorators — untrusted YAML is never parsed. Low real-world risk.
- Jest + Prisma 7's WASM engine (see above) — real DB-backed integration tests are blocked until this is resolved.
- After a detected refresh-token reuse (theft response), a duplicate `auth.refresh_token_reuse_detected` audit row can be written if the now-also-revoked sibling token is presented moments later — cosmetic double-logging of one incident, not a security issue, seen during manual testing.
- `RiskService`'s "impossible travel" is a country-plus-time-window heuristic, not a real distance/speed calculation — see "How fraud detection actually works." A legitimate, larger upgrade, not a bug.
- Redis is a hard dependency at boot (`REDIS_URL` is required, Joi-validated) even though most of what it backs degrades gracefully once running (queue producers time out instead of hanging, the revocation check fails open). Making Redis fully optional at startup too would need every module that depends on it to tolerate a missing connection from the start, which is a bigger change than this phase's scope — not done speculatively.

## Security notes

- Passwords: Argon2id, OWASP-baseline parameters (19 MiB memory cost, timeCost 2) — see `ARGON2_OPTIONS` in `auth.service.ts`.
- Secrets: all via environment variables, validated at boot in `src/config/env.validation.ts`. Never commit `.env`.
- 2FA secrets: AES-256-GCM encrypted at rest with a key separate from the JWT signing secret (`TWO_FACTOR_ENCRYPTION_KEY`) — see `EncryptionService`.
- `AuditLog` is append-only by convention — application code should only ever `create()` rows there, never `update()`/`delete()`.
- Rate limiting: global default 100 req/min per IP; `/auth/login` (10/min), `/auth/register`, `/auth/login/verify`, `/auth/forgot-password`, `/auth/reset-password` (5/min each) — all verified to actually return 429 under a burst, not just configured and assumed to work.
- Card data never touches this server — Stripe Checkout is hosted by Stripe, keeping this app out of PCI-DSS scope beyond the lightest tier (SAQ A).
- Webhook payloads are cryptographically verified (`stripe.webhooks.constructEvent`) before any business logic runs — a request with a missing or invalid `Stripe-Signature` header is rejected with 400, confirmed with a real tampered-signature test, not just by reading the code.
- `.env` holds a real Stripe **test-mode** secret key — test mode cannot move real money, so the usual "rotate immediately" urgency for a leaked credential doesn't apply the same way it would to a live key, but it's still gitignored and never committed like every other secret here.
- Per-IP rate limiting only correctly identifies "per IP" once `app.set('trust proxy', 1)` is doing its job — confirmed this now resolves real client IPs via `X-Forwarded-For` rather than a single shared proxy address for everyone (see "How background jobs actually work").
- Access-token revocation (admin suspend, `logout-all`, password reset, account deletion) is real but layered: a token can still work for its full remaining TTL if Redis is down when revocation was requested (the write side also fails open, logging loudly rather than failing the caller's action outright) — the durable, load-bearing revocation is still refresh-token invalidation in Postgres, which doesn't depend on Redis at all.
- A verification/reset/login-code email job's raw secret sits in Redis only as long as the job is queued or (on failure) for at most 1 hour — not the global 7-day job-retention default — specifically because that data is a plaintext single-use credential, unlike everything else that flows through the queues.
