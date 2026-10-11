import { DateTime, IANAZone } from "luxon";
import type { ArticlePreview } from "@dailybrief/shared";
import { AppError } from "./errors";

export type RecentArticleWindow = {
  start: Date;
  end: Date;
  timezone: string;
  date: string;
};

export type RecentArticleOptions = { window: RecentArticleWindow; newestFirst?: boolean };

// Calendar days are used instead of a 48-hour duration: DST days can have 23 or 25 hours.
export function recentArticleWindow(timezone: string, now = new Date()): RecentArticleWindow {
  if (!IANAZone.isValidZone(timezone))
    throw new AppError(400, "Fuseau horaire invalide.", "INVALID_TIMEZONE");
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  if (!today.isValid) throw new AppError(400, "Date d'exécution invalide.", "INVALID_DATE");
  return {
    start: today.minus({ days: 1 }).toJSDate(),
    end: today.plus({ days: 1 }).toJSDate(),
    timezone,
    date: today.toISODate()!,
  };
}

// A date without an offset describes local publication time, never the server's timezone.
export function parsePublicationDate(value: string, timezone = "UTC"): string | null {
  const raw = value.replace(/\u00a0/g, " ").trim();
  if (!raw || !IANAZone.isValidZone(timezone)) return null;
  const options = { zone: timezone };
  for (const parsed of [
    DateTime.fromISO(raw, options),
    DateTime.fromRFC2822(raw, options),
    // Some feeds publish a stale weekday label next to an otherwise valid date.
    DateTime.fromRFC2822(raw.replace(/^(?:mon|tue|wed|thu|fri|sat|sun),\s*/i, ""), options),
    DateTime.fromHTTP(raw, options),
  ]) {
    if (parsed.isValid) return parsed.toUTC().toISO();
  }
  const normalized = raw
    .toLocaleLowerCase("fr-FR")
    .replace(/^(?:publié(?:e)?\s+(?:le\s+)?|le\s+)/, "")
    .replace(/^(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+/, "")
    .replace(/\b1er\b/g, "1")
    .replace(/\s+(?:à|a)\s+/g, " ")
    .replace(/(\d)h(?=\d)/g, "$1:")
    .replace(/\s+/g, " ");
  for (const format of [
    "d LLLL yyyy HH:mm:ss",
    "d LLLL yyyy HH:mm",
    "d LLLL yyyy",
    "d LLL yyyy HH:mm",
    "d LLL yyyy",
    "d/M/yyyy HH:mm:ss",
    "d/M/yyyy HH:mm",
    "d/M/yyyy",
    "yyyy-MM-dd HH:mm:ss",
    "yyyy-MM-dd HH:mm",
  ]) {
    const parsed = DateTime.fromFormat(normalized, format, { ...options, locale: "fr" });
    if (parsed.isValid) return parsed.toUTC().toISO();
  }
  return null;
}

export function filterRecentArticles<T extends Pick<ArticlePreview, "publishedAt">>(
  items: T[],
  window: RecentArticleWindow,
) {
  const ignored = { undated: 0, old: 0, future: 0 };
  const start = window.start.getTime();
  const end = window.end.getTime();
  const articles = items.flatMap((item) => {
    const parsed = item.publishedAt
      ? parsePublicationDate(item.publishedAt, window.timezone)
      : null;
    if (!parsed) {
      ignored.undated++;
      return [];
    }
    const timestamp = new Date(parsed).getTime();
    if (timestamp < start) {
      ignored.old++;
      return [];
    }
    if (timestamp >= end) {
      ignored.future++;
      return [];
    }
    return [{ ...item, publishedAt: parsed }];
  });
  const warnings: string[] = [];
  if (ignored.undated)
    warnings.push(`${ignored.undated} article(s) ignoré(s) : date de publication inexploitable.`);
  if (ignored.old) warnings.push(`${ignored.old} article(s) antérieur(s) à la veille ignoré(s).`);
  if (ignored.future)
    warnings.push(`${ignored.future} article(s) avec une date de publication future ignoré(s).`);
  return { articles, ignored, warnings };
}

export function isNewestFirst(items: Pick<ArticlePreview, "publishedAt">[]): boolean {
  if (!items.length) return false;
  let previous = Infinity;
  for (const item of items) {
    if (!item.publishedAt) return false;
    const timestamp = new Date(item.publishedAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp > previous) return false;
    previous = timestamp;
  }
  return true;
}
