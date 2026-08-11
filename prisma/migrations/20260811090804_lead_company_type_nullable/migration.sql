-- Widen leads.company_type to allow NULL: some bulk-imported rows have no
-- category on file, and dropping them from the directory to satisfy a
-- NOT NULL constraint would mean losing real, real attendees.
ALTER TABLE "leads" ALTER COLUMN "company_type" DROP NOT NULL;
