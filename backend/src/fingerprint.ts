import { createHash } from "node:crypto";
import { plainText } from "./rss";
import type { CollectedArticle } from "./collection";
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function canonicalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())) url.searchParams.delete(key);
    url.searchParams.sort(); return url.href;
  } catch { return null; }
}
export function articleIdentity(article: CollectedArticle) {
  const url = canonicalUrl(article.url); const content = plainText(article.content ?? article.description ?? "");
  const contentHash = sha256(`${plainText(article.title)}\n${content}`);
  const guid = article.guid?.trim() || null;
  return { canonicalUrl: url, contentHash, fingerprint: sha256(JSON.stringify([article.sourceId, guid ? ["guid", guid] : url ? ["url", url] : ["hash", contentHash]])), guid };
}
