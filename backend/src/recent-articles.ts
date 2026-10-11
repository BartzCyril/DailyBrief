import { DateTime, IANAZone } from "luxon";
import type { ArticlePreview } from "@dailybrief/shared";
import { AppError } from "./errors";
import { parsePublicationDate } from "./publication-date";
export { parsePublicationDate } from "./publication-date";

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
