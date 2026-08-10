-- AlterTable
ALTER TABLE "users" ADD COLUMN "admin_granted_directory_access" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "AdminAccessInviteStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- CreateTable
CREATE TABLE "admin_access_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invited_by_user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "grant_directory_access" BOOLEAN NOT NULL DEFAULT true,
    "status" "AdminAccessInviteStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "admin_access_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_access_invites_email_idx" ON "admin_access_invites"("email");

-- AddForeignKey
ALTER TABLE "admin_access_invites" ADD CONSTRAINT "admin_access_invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
