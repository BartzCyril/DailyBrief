-- CreateTable
CREATE TABLE "DailyBriefSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "collectionTime" TEXT NOT NULL DEFAULT '07:30',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "lastCollectionAt" TIMESTAMP(3),
    "nextCollectionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyBriefSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyBriefSettings_userId_key" ON "DailyBriefSettings"("userId");

-- CreateIndex
CREATE INDEX "DailyBriefSettings_collectionEnabled_nextCollectionAt_idx" ON "DailyBriefSettings"("collectionEnabled", "nextCollectionAt");

-- AddForeignKey
ALTER TABLE "DailyBriefSettings" ADD CONSTRAINT "DailyBriefSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

