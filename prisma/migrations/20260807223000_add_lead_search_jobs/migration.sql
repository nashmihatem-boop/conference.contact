-- CreateEnum
CREATE TYPE "LeadSearchJobStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "lead_search_jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "job_titles" JSONB,
    "status" "LeadSearchJobStatus" NOT NULL DEFAULT 'RUNNING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_search_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_search_results" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "apollo_person_id" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "company" TEXT,
    "linkedin" TEXT,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_search_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_search_jobs_user_id_created_at_idx" ON "lead_search_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_search_results_job_id_idx" ON "lead_search_results"("job_id");

-- AddForeignKey
ALTER TABLE "lead_search_jobs" ADD CONSTRAINT "lead_search_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_search_results" ADD CONSTRAINT "lead_search_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "lead_search_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
