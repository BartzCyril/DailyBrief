ALTER TABLE "DailyBriefSettings" ADD COLUMN "interestPrompt" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Source" ADD COLUMN "newestFirst" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Article" ADD COLUMN "relevant" BOOLEAN,
  ADD COLUMN "relevanceReason" TEXT,
  ADD COLUMN "analyzedAt" TIMESTAMP(3);
CREATE INDEX "Article_userId_publishedAt_relevant_idx" ON "Article"("userId", "publishedAt", "relevant");
ALTER TABLE "DailyBriefRun" ADD COLUMN "periodStart" TIMESTAMP(3),
  ADD COLUMN "periodEnd" TIMESTAMP(3),
  ADD COLUMN "briefDate" TEXT,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "interestPrompt" TEXT;
CREATE TABLE "DailyBrief" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'GENERATING',
  "content" JSONB,
  "articleCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyBrief_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyBrief_runId_key" ON "DailyBrief"("runId");
CREATE INDEX "DailyBrief_userId_date_createdAt_idx" ON "DailyBrief"("userId", "date", "createdAt");
ALTER TABLE "DailyBrief" ADD CONSTRAINT "DailyBrief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyBrief" ADD CONSTRAINT "DailyBrief_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DailyBriefRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
