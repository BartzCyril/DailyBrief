import { z } from "zod";
import type { Source } from "@prisma/client";
import type { ArticlePreview, JournalPreview } from "@dailybrief/shared";
import type { Db } from "./db";

const snapshotSchema = z.object({
  url: z.string(),
  selector: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  unresolvedCount: z.number().int().nonnegative(),
  measuredAt: z.iso.datetime(),
});

export async function recordJournalInventory(
  db: Db,
  userId: string,
  source: Pick<Source, "id" | "url" | "articleLinkSelector">,
  inventory: { articles: ArticlePreview[]; journals: JournalPreview[] },
) {
  if (!source.articleLinkSelector) return;
  // Ignore a source removed or edited while its notices were being resolved.
  await db.source.updateMany({
    where: {
      id: source.id,
      userId,
      url: source.url,
      articleLinkSelector: source.articleLinkSelector,
      type: "RSS",
    },
    data: {
      journalInventory: {
        url: source.url,
        selector: source.articleLinkSelector,
        counts: Object.fromEntries(
          inventory.journals.map((journal) => [journal.domain, journal.count]),
        ),
        unresolvedCount: inventory.articles.filter((article) => article.resolutionError).length,
        measuredAt: new Date().toISOString(),
      },
    },
  });
}

export async function readJournalInventory(db: Db, userId: string) {
  const sources = await db.source.findMany({
    where: { userId, type: "RSS", articleLinkSelector: { not: null } },
    select: { url: true, articleLinkSelector: true, journalInventory: true },
  });
  const counts = new Map<string, number>();
  let lastInventoriedAt: string | null = null;
  let unresolvedCount = 0;
  for (const source of sources) {
    const parsed = snapshotSchema.safeParse(source.journalInventory);
    if (
      !parsed.success ||
      parsed.data.url !== source.url ||
      parsed.data.selector !== source.articleLinkSelector
    )
      continue;
    const snapshot = parsed.data;
    for (const [domain, count] of Object.entries(snapshot.counts))
      counts.set(domain, (counts.get(domain) ?? 0) + count);
    unresolvedCount += snapshot.unresolvedCount;
    if (!lastInventoriedAt || snapshot.measuredAt > lastInventoriedAt)
      lastInventoriedAt = snapshot.measuredAt;
  }
  return { counts, lastInventoriedAt, unresolvedCount };
}
