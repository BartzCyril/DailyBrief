-- CreateEnum
CREATE TYPE "NewsletterStatus" AS ENUM ('GENERATING', 'READY', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "canonicalUrl" TEXT,
    "guid" TEXT,
    "content" TEXT,
    "description" TEXT,
    "publishedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "summaryTitle" TEXT,
    "summary" TEXT,
    "keyPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summarizedAt" TIMESTAMP(3),
    "summaryError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Newsletter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "NewsletterStatus" NOT NULL DEFAULT 'GENERATING',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Newsletter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsletterArticle" (
    "newsletterId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,

    CONSTRAINT "NewsletterArticle_pkey" PRIMARY KEY ("newsletterId","articleId")
);

-- CreateTable
CREATE TABLE "DailyBriefRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "sourcesProcessed" INTEGER NOT NULL DEFAULT 0,
    "sourcesFailed" INTEGER NOT NULL DEFAULT 0,
    "articlesCollected" INTEGER NOT NULL DEFAULT 0,
    "newArticles" INTEGER NOT NULL DEFAULT 0,
    "articlesSummarized" INTEGER NOT NULL DEFAULT 0,
    "emailSent" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "sourceResults" JSONB,

    CONSTRAINT "DailyBriefRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_fingerprint_key" ON "Article"("fingerprint");

-- CreateIndex
CREATE INDEX "Article_userId_summarizedAt_idx" ON "Article"("userId", "summarizedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Article_userId_canonicalUrl_key" ON "Article"("userId", "canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Article_userId_contentHash_key" ON "Article"("userId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "Article_sourceId_guid_key" ON "Article"("sourceId", "guid");

-- CreateIndex
CREATE INDEX "Newsletter_userId_status_idx" ON "Newsletter"("userId", "status");

-- CreateIndex
CREATE INDEX "NewsletterArticle_articleId_idx" ON "NewsletterArticle"("articleId");

-- CreateIndex
CREATE INDEX "DailyBriefRun_userId_startedAt_idx" ON "DailyBriefRun"("userId", "startedAt");

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Newsletter" ADD CONSTRAINT "Newsletter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsletterArticle" ADD CONSTRAINT "NewsletterArticle_newsletterId_fkey" FOREIGN KEY ("newsletterId") REFERENCES "Newsletter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsletterArticle" ADD CONSTRAINT "NewsletterArticle_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyBriefRun" ADD CONSTRAINT "DailyBriefRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

