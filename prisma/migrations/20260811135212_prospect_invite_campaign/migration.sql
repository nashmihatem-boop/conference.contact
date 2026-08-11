-- CreateEnum
CREATE TYPE "ProspectInviteQueueStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED_EXISTING_USER', 'SKIPPED_UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED');

-- CreateTable
CREATE TABLE "prospect_invite_queue" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "ProspectInviteQueueStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "prospect_invite_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_invite_campaign_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "daily_cap" INTEGER NOT NULL DEFAULT 25,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_invite_campaign_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prospect_invite_queue_email_key" ON "prospect_invite_queue"("email");

-- CreateIndex
CREATE INDEX "prospect_invite_queue_status_created_at_idx" ON "prospect_invite_queue"("status", "created_at");

-- AddForeignKey
ALTER TABLE "prospect_invite_queue" ADD CONSTRAINT "prospect_invite_queue_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
