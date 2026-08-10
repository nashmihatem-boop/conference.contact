-- CreateEnum
CREATE TYPE "ContactReason" AS ENUM ('BILLING', 'ACCOUNT_ISSUE', 'REMOVE_RECORD', 'OTHER');

-- CreateTable
CREATE TABLE "contact_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "ContactReason" NOT NULL DEFAULT 'OTHER',
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_messages_resolved_created_at_idx" ON "contact_messages"("resolved", "created_at");
