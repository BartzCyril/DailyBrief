import { Prisma } from "@prisma/client";
import type { Db } from "./db";
import { SourceCollector, getSettings, type CollectedArticle, type CollectionRunner, type RunTrigger } from "./collection";
import { UserCollectionLock } from "./lock";
import type { SummaryProvider } from "./ai";
import type { NewsletterSender } from "./email";
import { renderNewsletter } from "./newsletter-template";
import { articleIdentity } from "./fingerprint";
import { nextCollection } from "./schedule";
import { AppError } from "./errors";
export type DailyBriefRunResult = { status: "SENT" | "NO_NEW_ARTICLES" | "FAILED"; sourcesProcessed: number; sourcesFailed: number; articlesCollected: number; newArticles: number; articlesSummarized: number; newsletterId?: string; emailSent: boolean };
export class DailyBriefPipelineService implements CollectionRunner {
  constructor(private db: Db, private collector: SourceCollector, private lock: UserCollectionLock, private summary: SummaryProvider, private email: NewsletterSender) {}
  private async persist(userId: string, article: CollectedArticle): Promise<boolean> {
    const identity = articleIdentity(article);
    const where: Prisma.ArticleWhereInput = { userId, OR: [{ fingerprint: identity.fingerprint }, { contentHash: identity.contentHash }, ...(identity.canonicalUrl ? [{ canonicalUrl: identity.canonicalUrl }] : []), ...(identity.guid ? [{ sourceId: article.sourceId, guid: identity.guid }] : [])] };
    if (await this.db.article.findFirst({ where })) return false;
    try {
      await this.db.article.create({ data: { userId, sourceId: article.sourceId, title: article.title, url: article.url, content: article.content, description: article.description, publishedAt: article.publishedAt ? new Date(article.publishedAt) : null, ...identity } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && await this.db.article.findFirst({ where })) return false;
      throw error;
    }
  }
  async run(userId: string, trigger: RunTrigger = "manual"): Promise<DailyBriefRunResult> {
    return this.lock.run(userId, async assertOwned => {
      const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
      const settings = await getSettings(this.db, userId);
      const run = await this.db.dailyBriefRun.create({ data: { userId } });
      const result: DailyBriefRunResult = { status: "FAILED", sourcesProcessed: 0, sourcesFailed: 0, articlesCollected: 0, newArticles: 0, articlesSummarized: 0, emailSent: false };
      let newsletterId: string | undefined; let accepted = false;
      try {
        const sources = await this.collector.collect(userId);
        result.sourcesProcessed = sources.length; result.sourcesFailed = sources.filter(source => !source.success).length;
        const articles = sources.flatMap(source => source.articles); result.articlesCollected = articles.length;
        await this.db.dailyBriefRun.update({ where: { id: run.id }, data: { sourceResults: sources.map(({ articles, ...source }) => ({ ...source, articlesCollected: articles.length })) } });
        for (const article of articles) if (await this.persist(userId, article)) result.newArticles++;
        const pending = await this.db.article.findMany({ where: { userId, source: { enabled: true }, newsletters: { none: { newsletter: { status: { in: ["SENT", "SENDING"] } } } } }, include: { source: true }, orderBy: { createdAt: "asc" }, take: 100 });
        const included: typeof pending = [];
        for (let article of pending) {
          if (!article.summary || !article.summarizedAt) {
            try {
              const summary = await this.summary.summarize({ title: article.title, content: article.content || article.description || article.title, url: article.url });
              article = { ...article, ...await this.db.article.update({ where: { id: article.id }, data: { summaryTitle: summary.title, summary: summary.summary, keyPoints: summary.keyPoints, summarizedAt: new Date(), summaryError: null } }) }; result.articlesSummarized++;
            } catch (error) { await this.db.article.update({ where: { id: article.id }, data: { summaryError: error instanceof AppError ? error.message : "Échec du résumé IA." } }); continue; }
          }
          included.push(article);
        }
        if (!included.length) { result.status = pending.length || result.sourcesFailed ? "FAILED" : "NO_NEW_ARTICLES"; return result; }
        const rendered = renderNewsletter(included.map(article => ({ title: article.summaryTitle ?? article.title, summary: article.summary!, keyPoints: article.keyPoints, url: article.url, source: `${article.source.type} · ${new URL(article.source.url).hostname}`, publishedAt: article.publishedAt })), settings.timezone);
        const newsletter = await this.db.newsletter.create({ data: { userId, recipientEmail: user.email, subject: rendered.subject, status: "READY", articles: { create: included.map(article => ({ articleId: article.id })) } } });
        newsletterId = newsletter.id; result.newsletterId = newsletterId;
        await assertOwned();
        await this.db.newsletter.update({ where: { id: newsletterId }, data: { status: "SENDING" } });
        await this.email.send({ ...rendered, to: user.email, newsletterId }); accepted = true;
        await this.db.newsletter.update({ where: { id: newsletterId }, data: { status: "SENT", sentAt: new Date() } });
        result.status = "SENT"; result.emailSent = true; return result;
      } catch (error) {
        if (newsletterId && !accepted) await this.db.newsletter.update({ where: { id: newsletterId }, data: { status: "FAILED", error: "Échec de l'envoi de la newsletter." } });
        await this.db.dailyBriefRun.update({ where: { id: run.id }, data: { error: error instanceof AppError ? error.message : "Échec du pipeline DailyBrief." } });
        return result;
      } finally {
        const now = new Date();
        const { newsletterId: _newsletterId, ...runData } = result;
        await this.db.$transaction([
          this.db.dailyBriefRun.update({ where: { id: run.id }, data: { ...runData, finishedAt: now } }),
          this.db.dailyBriefSettings.update({ where: { userId }, data: { lastCollectionAt: now, ...(trigger === "scheduled" && settings.collectionEnabled ? { nextCollectionAt: nextCollection(settings.collectionTime, settings.timezone, now) } : {}) } }),
        ]);
      }
    });
  }
}
