-- Whole-hour daily schedules replace minute-level configuration.
UPDATE "DailyBriefSettings"
SET "collectionTime" = split_part("collectionTime", ':', 1) || ':00',
    "nextCollectionAt" = (
      date_trunc('hour', ("nextCollectionAt" AT TIME ZONE 'UTC') AT TIME ZONE "timezone")
      AT TIME ZONE "timezone"
    ) AT TIME ZONE 'UTC'
WHERE "collectionTime" !~ ':00$';

ALTER TABLE "DailyBriefSettings"
  ALTER COLUMN "collectionTime" SET DEFAULT '07:00',
  ADD CONSTRAINT "DailyBriefSettings_whole_hour" CHECK ("collectionTime" ~ '^([01][0-9]|2[0-3]):00$');
