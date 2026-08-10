-- CreateEnum
CREATE TYPE "CreditGrantSource" AS ENUM ('CREDIT_PACK_PURCHASE', 'LEAD_FINDER_TIER_GRANT', 'ADMIN_ADJUSTMENT');

-- CreateTable
CREATE TABLE "credit_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credits" INTEGER NOT NULL,
    "source" "CreditGrantSource" NOT NULL,
    "amount_paid_cents" INTEGER,
    "stripe_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_grants_user_id_idx" ON "credit_grants"("user_id");

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
