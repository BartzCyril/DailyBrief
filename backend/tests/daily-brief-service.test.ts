import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { BriefInput, SummaryProvider } from "../src/ai";
import { DailyBriefService } from "../src/daily-brief";
import { AppError } from "../src/errors";
import { recentArticleWindow } from "../src/recent-articles";
import { connect, db, disconnect } from "./helpers";

describe("persisted Daily Brief synthesis", () => {
  const window = recentArticleWindow("Europe/Paris", new Date("2026-03-29T12:00:00Z"));
  let userId = "";
  let sourceId = "";
  let runId = "";
  const otherUsers: string[] = [];
  let inputs: BriefInput[] = [];
  let fail = false;
  let changeSource = false;
  const provider: SummaryProvider = {
    async summarize() {
      throw new Error("Synthesis must consume saved summaries");
    },
    async generateBrief(input) {
      inputs.push(input);
      if (fail)
        throw new AppError(503, "Le modèle de synthèse est indisponible.", "AI_UNAVAILABLE");
      if (changeSource)
        await db.source.update({ where: { id: sourceId }, data: { enabled: false } });
      return {
        headline: "L’essentiel du jour",
        lead: "Les nouvelles importantes.",
        stories: [
          {
            title: "Sujet majeur",
            text: "Les faits convergents de la veille.",
            articleIds: input.articles.map((article) => article.id),
          },
        ],
        otherNews: [],
        trends: "",
      };
    },
  };
  const service = new DailyBriefService(db, provider);
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@brief.example`, passwordHash: "unused" },
    });
    userId = user.id;
    sourceId = (
      await db.source.create({ data: { userId, url: "https://feed.example/news", type: "RSS" } })
    ).id;
    runId = (
      await db.dailyBriefRun.create({
        data: {
          userId,
          trigger: "manual",
          periodStart: window.start,
          periodEnd: window.end,
          timezone: window.timezone,
          briefDate: window.date,
          interestPrompt: "Technologie et recherche.",
        },
      })
    ).id;
    inputs = [];
    fail = false;
    changeSource = false;
  });
  afterEach(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, ...otherUsers.splice(0)] } } });
  });
  async function savedArticle(
    title: string,
    overrides: Partial<Prisma.ArticleUncheckedCreateInput> = {},
  ) {
    return db.article.create({
      data: {
        userId,
        sourceId,
        title,
        url: `https://article.example/${randomUUID()}`,
        contentHash: randomUUID(),
        fingerprint: randomUUID(),
        publishedAt: new Date("2026-03-29T09:00:00Z"),
        relevant: true,
        relevanceReason: "Sujet suivi.",
        analyzedAt: new Date(),
        summary: `Résumé de ${title}`,
        summaryTitle: title,
        summarizedAt: new Date(),
        keyPoints: ["Un fait important"],
        contentFetchedAt: new Date(),
        ...overrides,
      },
    });
  }
  test("uses all eligible saved summaries from J and J-1, excluding other owners, dates and disabled sources", async () => {
    const today = await savedArticle("Aujourd’hui");
    const yesterday = await savedArticle("Hier", { publishedAt: new Date("2026-03-28T10:00:00Z") });
    await savedArticle("Ancien", { publishedAt: new Date(window.start.getTime() - 1) });
    await savedArticle("Futur", { publishedAt: window.end });
    await savedArticle("Sans date", { publishedAt: null });
    await savedArticle("Hors sujet", { relevant: false });
    await savedArticle("Sans résumé", { summary: null });
    await savedArticle("Extrait du flux", { contentFetchedAt: null });
    const disabled = await db.source.create({
      data: { userId, url: "https://feed.example/disabled", type: "RSS", enabled: false },
    });
    await savedArticle("Source désactivée", { sourceId: disabled.id });
    const stranger = await db.user.create({
      data: { email: `${randomUUID()}@brief.example`, passwordHash: "unused" },
    });
    otherUsers.push(stranger.id);
    const foreignSource = await db.source.create({
      data: { userId: stranger.id, url: "https://feed.example/foreign", type: "RSS" },
    });
    await savedArticle("Veille privée", { userId: stranger.id, sourceId: foreignSource.id });
    const result = await service.run(userId, runId);
    expect(result).toMatchObject({
      status: "READY",
      date: "2026-03-29",
      timezone: "Europe/Paris",
      articleCount: 2,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      date: "2026-03-29",
      timezone: "Europe/Paris",
      interestPrompt: "Technologie et recherche.",
    });
    expect(inputs[0]!.articles.map((article) => article.id)).toEqual([today.id, yesterday.id]);
    expect(JSON.stringify(inputs)).not.toContain("Veille privée");
    expect(await db.newsletter.count({ where: { userId } })).toBe(0);
  });
  test("retry after failure reuses one brief row and leaves every saved article unchanged", async () => {
    const article = await savedArticle("Nouvelle importante");
    fail = true;
    await expect(service.run(userId, runId)).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
    const failed = await db.dailyBrief.findUniqueOrThrow({ where: { runId } });
    expect(failed).toMatchObject({
      status: "FAILED",
      content: null,
      error: "Le modèle de synthèse est indisponible.",
    });
    expect(await db.article.findUniqueOrThrow({ where: { id: article.id } })).toEqual(article);
    fail = false;
    const retried = await service.run(userId, runId);
    expect(retried).toMatchObject({ id: failed.id, status: "READY", articleCount: 1, error: null });
    expect(await db.dailyBrief.count({ where: { runId } })).toBe(1);
    expect(await db.article.findUniqueOrThrow({ where: { id: article.id } })).toEqual(article);
    await db.dailyBriefRun.update({ where: { id: runId }, data: { finishedAt: new Date() } });
    expect((await service.run(userId, runId)).id).toBe(failed.id);
    expect(inputs).toHaveLength(2);
  });
  test("a source disabled during synthesis prevents publishing stale content", async () => {
    await savedArticle("Nouvelle importante");
    changeSource = true;
    await expect(service.run(userId, runId)).rejects.toMatchObject({ code: "BRIEF_INPUT_CHANGED" });
    expect(await db.dailyBrief.findUniqueOrThrow({ where: { runId } })).toMatchObject({
      status: "FAILED",
      content: null,
    });
  });
  test("an empty selection is saved once and never invokes the synthesis model", async () => {
    await savedArticle("Hors sujet", { relevant: false });
    const first = await service.run(userId, runId);
    expect(first).toMatchObject({ status: "EMPTY", articleCount: 0, content: null });
    expect((await service.run(userId, runId)).id).toBe(first.id);
    expect(inputs).toHaveLength(0);
    expect(await db.dailyBrief.count({ where: { runId } })).toBe(1);
  });
});
