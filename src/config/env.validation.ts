import * as Joi from 'joi';

/**
 * The app refuses to boot if any required variable is missing or malformed —
 * that's deliberate. A backend silently running with an unset secret is a
 * worse failure mode than one that won't start.
 *
 * Extend this schema in the same commit that introduces the module needing
 * a new variable (e.g. add STRIPE_SECRET_KEY here when billing/ lands).
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),

  // Backs BullMQ (email + Stripe webhook processing queues) and the
  // short-TTL access-token revocation list admin suspension writes to.
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // Frontend origin — used for CORS in production and for building links
  // (email verification, password reset) that point back at the Astro site.
  FRONTEND_URL: Joi.string().uri().required(),

  // Access tokens are short-lived JWTs signed with this secret. Refresh
  // tokens are deliberately NOT JWTs — they're opaque random values, hashed
  // before storage, so a stolen DB dump doesn't hand out working sessions
  // and revocation is a real DELETE/UPDATE rather than "wait for expiry".
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  // Numeric seconds, not a duration string — @nestjs/jwt's typings want
  // `number | StringValue` (a branded literal type), which a plain runtime
  // string from ConfigService can never satisfy at compile time. Seconds
  // avoid the mismatch and are unambiguous.
  JWT_ACCESS_EXPIRY_SECONDS: Joi.number().integer().min(60).default(900),
  REFRESH_TOKEN_EXPIRY_DAYS: Joi.number().integer().min(1).default(30),

  // AES-256-GCM key (32 raw bytes, base64-encoded) used to encrypt TOTP 2FA
  // secrets at rest. Deliberately a separate key from JWT_ACCESS_SECRET —
  // rotating one should never force rotating the other.
  TWO_FACTOR_ENCRYPTION_KEY: Joi.string().base64().required(),

  RESEND_API_KEY: Joi.string().required(),
  // Where the /contact form's messages land — see ContactController.
  SUPPORT_EMAIL: Joi.string().email().required(),
  // Not `.email()` — this is a raw email "From" header value, which Resend
  // (and RFC 5322) allow in "Display Name <email@domain>" form, not just a
  // bare address. Must be on a domain verified in the Resend dashboard for
  // production sends; the resend.dev address below only works for testing.
  RESEND_FROM_EMAIL: Joi.string()
    .required()
    .default('conference.contact <onboarding@resend.dev>'),

  // Brute-force protection thresholds — configurable rather than hardcoded
  // so they can be tuned without a redeploy-worthy code change.
  LOGIN_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  LOGIN_LOCKOUT_MINUTES: Joi.number().integer().min(1).default(15),

  // Cap on concurrent active sessions per account — signing in on a device
  // past this limit auto-signs-out the account's oldest session. The real
  // anti-account-sharing enforcement (see SessionsService.enforceLimit).
  MAX_TRUSTED_DEVICES: Joi.number().integer().min(1).default(3),

  // A login's risk score (RiskService) at or above this writes a distinct
  // auth.high_risk_login audit entry, surfaced in the admin flagged-
  // sessions view. Tunable without a redeploy for the same reason the
  // brute-force thresholds above are.
  RISK_HIGH_THRESHOLD: Joi.number().integer().min(0).default(50),

  // Test-mode keys start with sk_test_ / whsec_ — use those until you're
  // deliberately ready to take real payments.
  STRIPE_SECRET_KEY: Joi.string().required(),
  STRIPE_WEBHOOK_SECRET: Joi.string().required(),

  // How long a PAST_DUE subscription keeps product access before it's
  // treated the same as no subscription — see subscription-access.util.ts.
  PAYMENT_GRACE_PERIOD_DAYS: Joi.number().integer().min(0).default(7),

  // Parses Lead Finder's natural-language queries into structured filters
  // via Claude's tool-use — see ClaudeService.
  ANTHROPIC_API_KEY: Joi.string().required(),

  // Live web lead discovery/enrichment — see ApolloService. Key must be
  // scoped to (at minimum) mixed_people/api_search and people/match.
  APOLLO_API_KEY: Joi.string().required(),
  // Hard cap on candidates enriched per single "Find leads" run — each
  // enrichment call spends a real Apollo credit, so one query should never
  // be able to silently burn the whole remaining monthly allowance.
  LEAD_SEARCH_MAX_RESULTS: Joi.number().integer().min(1).default(50),
});
