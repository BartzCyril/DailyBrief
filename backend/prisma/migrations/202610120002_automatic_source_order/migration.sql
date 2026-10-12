-- Preserve the legacy column for compatibility; users no longer configure ordering.
UPDATE "Source" SET "newestFirst" = true;
ALTER TABLE "Source" ALTER COLUMN "newestFirst" SET DEFAULT true;
