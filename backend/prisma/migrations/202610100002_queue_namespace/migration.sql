ALTER TABLE "DailyBriefRun" ADD COLUMN "queuePrefix" TEXT;
CREATE INDEX "DailyBriefRun_queuePrefix_finishedAt_idx" ON "DailyBriefRun"("queuePrefix", "finishedAt");
