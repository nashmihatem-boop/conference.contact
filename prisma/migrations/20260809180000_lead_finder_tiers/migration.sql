-- AlterTable
ALTER TABLE "users" ALTER COLUMN "lead_finder_credits" SET DEFAULT 50;

-- CreateTable
CREATE TABLE "lead_finder_tiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "stripe_price_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "recurring" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_finder_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_finder_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "tier_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_finder_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_finder_tiers_slug_key" ON "lead_finder_tiers"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "lead_finder_tiers_stripe_price_id_key" ON "lead_finder_tiers"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_finder_subscriptions_stripe_subscription_id_key" ON "lead_finder_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "lead_finder_subscriptions_user_id_status_idx" ON "lead_finder_subscriptions"("user_id", "status");

-- AddForeignKey
ALTER TABLE "lead_finder_subscriptions" ADD CONSTRAINT "lead_finder_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_finder_subscriptions" ADD CONSTRAINT "lead_finder_subscriptions_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "lead_finder_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
