-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "risk_score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "risk_signals" JSONB;

-- CreateIndex
CREATE INDEX "sessions_risk_score_created_at_idx" ON "sessions"("risk_score", "created_at");
