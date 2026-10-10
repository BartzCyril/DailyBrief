ALTER TABLE "DailyBriefRun" ADD COLUMN "queueJobId" TEXT,
  ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "newsletterId" TEXT;
CREATE UNIQUE INDEX "DailyBriefRun_queueJobId_key" ON "DailyBriefRun"("queueJobId");
