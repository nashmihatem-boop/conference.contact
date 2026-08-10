-- AlterTable
ALTER TABLE "users" ADD COLUMN "lead_finder_credits" INTEGER NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "lead_finder_used_count",
DROP COLUMN "lead_finder_period_start";

-- CreateTable
CREATE TABLE "credit_packs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_packs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_packs_slug_key" ON "credit_packs"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "credit_packs_stripe_price_id_key" ON "credit_packs"("stripe_price_id");
