import { XMLParser } from "fast-xml-parser";
import { load } from "cheerio";
import type { ArticlePreview, SourcePreview } from "@dailybrief/shared";
import { fetchRemoteText, type FetchText } from "./network";
import { AppError } from "./errors";
import { prepareFeedXml } from "./feed-xml";
import {
  filterRecentArticles,
  isNewestFirst,
  parsePublicationDate,
  type RecentArticleOptions,
} from "./recent-articles";

export function plainText(html: string): string {
  const $ = load(html);
  $("script,style").remove();
  return $.text().replace(/\s+/g, " ").trim();
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).find((item) => item.trim()) ?? "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return String(record(value)["#text"] ?? "");
}
export function articleUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function articleDate(value: string, timezone = "UTC"): string | null {
  return parsePublicationDate(value, timezone);
}
export function parseRss(
  xml: string,
  url: string,
  allItems = false,
  options?: RecentArticleOptions,
): SourcePreview {
  const prepared = prepareFeedXml(xml);
  const root = record(
    new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(
      prepared.xml,
    ),
  );
  const rss = record(root.rss);
  const feed = record(rss.channel ?? root.feed);
  if (!rss.channel && !root.feed)
    throw new AppError(422, "Ce document n'est pas un flux RSS ou Atom.", "INVALID_FEED");
  const items = list(feed.item ?? feed.entry).slice(0, allItems || options ? undefined : 500);
  if (!items.length) throw new AppError(422, "Le flux ne contient aucun article.", "EMPTY_FEED");
  const dates = items.map((item) => {
    const entry = record(item);
    return articleDate(
      text(
        entry.pubDate ??
          entry.published ??
          entry.updated ??
          record(record(entry.date).time)["@_datetime"] ??
          entry.date,
      ),
      options?.window.timezone,
    );
  });
  const warnings = [...prepared.warnings];
  // The entire feed is already available. Validate its order rather than inferring
  // it from a prefix, which could discard a recent item placed after an old one.
  const sorted = isNewestFirst(dates.map((publishedAt) => ({ publishedAt })));
  if (options?.newestFirst && !sorted)
    warnings.push("L'ordre chronologique n'est pas respecté : tous les items ont été vérifiés.");
  const cutoff =
    options && sorted
      ? dates.findIndex((date) => new Date(date!).getTime() < options.window.start.getTime())
      : -1;
  if (cutoff >= 0)
    warnings.push(
      "Lecture du flux arrêtée aux articles antérieurs à la veille (ordre chronologique vérifié).",
    );
  const articles: ArticlePreview[] = items
    .slice(0, cutoff < 0 ? undefined : cutoff + 1)
    .map((item, index) => {
      const entry = record(item);
      const atomLinks = list(entry.link).map(record);
      const link =
        atomLinks.find((link) => link["@_rel"] === "alternate") ??
        atomLinks.find((link) => !link["@_rel"]);
      const rssLink = list(entry.link)
        .map(text)
        .find((item) => item.trim());
      const rawLink = rssLink ?? text(link?.["@_href"]);
      const description = plainText(text(entry.description ?? entry.summary));
      const content = plainText(
        text(entry.encoded ?? entry.content ?? entry.description ?? entry.summary),
      );
      return {
        title: plainText(text(entry.title)) || "Sans titre",
        url: rawLink ? articleUrl(rawLink, url) : null,
        publishedAt: dates[index] ?? null,
        description: description || null,
        content: content || null,
        guid: text(entry.guid ?? entry.id) || null,
      };
    });
  const recent = options ? filterRecentArticles(articles, options.window) : null;
  warnings.push(...(recent?.warnings ?? []));
  return {
    feed: { title: plainText(text(feed.title)) || "Flux RSS", url },
    articles: recent?.articles ?? articles,
    ...(warnings.length ? { warnings } : {}),
  };
}
export class RssService {
  constructor(private fetchText: FetchText = fetchRemoteText) {}
  async collect(
    url: string,
    allItems = false,
    options?: RecentArticleOptions,
  ): Promise<SourcePreview> {
    return parseRss(await this.fetchText(url), url, allItems, options);
  }
}
