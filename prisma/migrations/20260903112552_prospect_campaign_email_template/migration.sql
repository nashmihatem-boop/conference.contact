-- AlterTable
ALTER TABLE "prospect_invite_campaign_settings" ADD COLUMN "email_subject" TEXT,
ADD COLUMN "email_heading" TEXT,
ADD COLUMN "email_body" TEXT,
ADD COLUMN "email_cta_label" TEXT,
ADD COLUMN "email_footnote" TEXT;
