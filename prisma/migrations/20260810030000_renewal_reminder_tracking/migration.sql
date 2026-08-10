ALTER TABLE "subscriptions" ADD COLUMN "renewal_reminder_sent_for_period_end" TIMESTAMP(3);
ALTER TABLE "lead_finder_subscriptions" ADD COLUMN "renewal_reminder_sent_for_period_end" TIMESTAMP(3);
