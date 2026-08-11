-- AlterTable
ALTER TABLE "users" ADD COLUMN "admin_granted_lead_finder_access" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "admin_access_invites" ADD COLUMN "grant_lead_finder_access" BOOLEAN NOT NULL DEFAULT false;
