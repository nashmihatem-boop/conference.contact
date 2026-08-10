-- AlterTable
ALTER TABLE "leads" ADD COLUMN "approved" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "leads" ADD COLUMN "submitted_by_user_id" UUID;

-- CreateIndex
CREATE INDEX "leads_approved_idx" ON "leads"("approved");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
