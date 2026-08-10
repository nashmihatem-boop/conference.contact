-- CreateEnum
CREATE TYPE "CompanyType" AS ENUM ('ADVERTISER', 'AD_NETWORK', 'AFFILIATE', 'AFFILIATE_NETWORK', 'AGENCY', 'SOLUTION_PROVIDER');

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "company" TEXT,
    "website" TEXT,
    "linkedin" TEXT,
    "app_link" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "company_type" "CompanyType" NOT NULL,
    "likely_to_attend" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_company_type_idx" ON "leads"("company_type");

-- CreateIndex
CREATE INDEX "leads_likely_to_attend_idx" ON "leads"("likely_to_attend");

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "lead_finder_used_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lead_finder_period_start" TIMESTAMP(3);
