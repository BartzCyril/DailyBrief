ALTER TABLE "JournalAccess"
  ADD COLUMN "loginUrl" TEXT,
  ADD COLUMN "emailSelector" TEXT,
  ADD COLUMN "passwordSelector" TEXT,
  ADD COLUMN "submitSelector" TEXT,
  ADD COLUMN "successSelector" TEXT,
  ADD COLUMN "articleContentSelector" TEXT;
ALTER TABLE "Article" ADD COLUMN "contentAccessVersion" TEXT;
