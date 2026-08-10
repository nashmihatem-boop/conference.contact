-- Enforces at the database level what the application-layer check-then-act
-- logic in SubscriptionsService.createCheckoutSession /
-- LeadFinderBillingService.createCheckoutSession only approximates: at most
-- one ACTIVE/TRIALING/PAST_DUE row per user, per subscription type. Closes a
-- TOCTOU race where two concurrent checkout completions could each pass the
-- "no existing active subscription" read before either write lands, leaving
-- a user double-billed with two live subscriptions. Partial unique indexes
-- aren't representable in schema.prisma's declarative syntax, so this exists
-- only as a raw-SQL migration — `prisma db pull`/`migrate diff` will not
-- reproduce it from the schema file.
CREATE UNIQUE INDEX "subscriptions_one_active_per_user"
  ON "subscriptions" ("user_id")
  WHERE "status" IN ('ACTIVE', 'TRIALING', 'PAST_DUE');

CREATE UNIQUE INDEX "lead_finder_subscriptions_one_active_per_user"
  ON "lead_finder_subscriptions" ("user_id")
  WHERE "status" IN ('ACTIVE', 'TRIALING', 'PAST_DUE');
