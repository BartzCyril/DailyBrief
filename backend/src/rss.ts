import { XMLParser } from "fast-xml-parser";
import { load } from "cheerio";
import type { ArticlePreview, SourcePreview } from "@dailybrief/shared";
import { fetchRemoteText, type FetchText } from "./network";
import { AppError } from "./errors";
import { prepareFeedXml } from "./feed-xml";

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
export function articleDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
export function parseRss(xml: string, url: string): SourcePreview {
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
  const articles: ArticlePreview[] = list(feed.item ?? feed.entry)
    .slice(0, 500)
    .map((item) => {
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
        publishedAt: articleDate(
          text(
            entry.pubDate ??
              entry.published ??
              entry.updated ??
              record(record(entry.date).time)["@_datetime"] ??
              entry.date,
          ),
        ),
        description: description || null,
        content: content || null,
        guid: text(entry.guid ?? entry.id) || null,
      };
    });
  if (!articles.length) throw new AppError(422, "Le flux ne contient aucun article.", "EMPTY_FEED");
  return {
    feed: { title: plainText(text(feed.title)) || "Flux RSS", url },
    articles,
    ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}),
  };
}
export class RssService {
  constructor(private fetchText: FetchText = fetchRemoteText) {}
  async collect(url: string): Promise<SourcePreview> {
    return parseRss(await this.fetchText(url), url);
  }
}
