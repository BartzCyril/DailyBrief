ALTER TABLE "Source" ADD COLUMN "articleLinkSelector" TEXT;
ALTER TABLE "Article" ADD COLUMN "contentUrl" TEXT,
    ADD COLUMN "contentLinkSelector" TEXT;
