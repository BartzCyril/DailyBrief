import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, connect, db, disconnect } from "./helpers";

describe("personalization settings and Daily Brief access", () => {
  const users: string[] = [];
  const owner = request.agent(app);
  const other = request.agent(app);
  beforeAll(async () => {
    await connect();
    for (const agent of [owner, other]) {
      const email = `brief-${randomUUID()}@example.com`;
      const registration = await agent
        .post("/auth/register")
        .send({ email, password: "Password123456!" });
      expect(registration.status).toBe(201);
      users.push(registration.body.id);
      expect(
        (await agent.post("/auth/login").send({ email, password: "Password123456!" })).status,
      ).toBe(200);
    }
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await disconnect();
  });
  test("persists interests, keeps schedule and isolates settings", async () => {
    const schedule = await owner
      .patch("/settings/dailybrief")
      .send({ collectionEnabled: true, collectionTime: "08:00", timezone: "Europe/Paris" });
    const customized = await owner
      .patch("/settings/dailybrief")
      .send({ interestPrompt: "  React et IA ; ignorer les faits divers.  " });
    expect(customized.status).toBe(200);
    expect(customized.body).toMatchObject({
      collectionEnabled: true,
      collectionTime: "08:00",
      interestPrompt: "React et IA ; ignorer les faits divers.",
    });
    expect(customized.body.nextCollectionAt).toBe(schedule.body.nextCollectionAt);
    expect((await owner.get("/settings/dailybrief")).body.interestPrompt).toBe(
      customized.body.interestPrompt,
    );
    expect((await other.get("/settings/dailybrief")).body.interestPrompt).toBe("");
    expect(
      (await owner.patch("/settings/dailybrief").send({ interestPrompt: "x".repeat(6001) })).status,
    ).toBe(400);
    expect((await owner.patch("/settings/dailybrief").send({ interestPrompt: 1 })).status).toBe(
      400,
    );
    expect(
      (
        await owner
          .patch("/settings/dailybrief")
          .send({ userId: users[1], interestPrompt: "other" })
      ).status,
    ).toBe(400);
    expect(
      (await owner.patch("/settings/dailybrief").send({ interestPrompt: "" })).body.interestPrompt,
    ).toBe("");
  });
  test("only exposes the current user's completed briefs", async () => {
    expect((await owner.get("/dailybrief/latest")).body).toBeNull();
    expect((await request(app).get("/dailybrief/latest")).status).toBe(401);
    const firstRun = await db.dailyBriefRun.create({
      data: { userId: users[0]!, status: "NO_NEW_ARTICLES", finishedAt: new Date() },
    });
    const brief = await db.dailyBrief.create({
      data: {
        userId: users[0]!,
        runId: firstRun.id,
        date: "2026-10-11",
        timezone: "Europe/Paris",
        status: "EMPTY",
      },
    });
    const processingRun = await db.dailyBriefRun.create({ data: { userId: users[0]! } });
    await db.dailyBrief.create({
      data: {
        userId: users[0]!,
        runId: processingRun.id,
        date: "2026-10-12",
        timezone: "Europe/Paris",
        status: "GENERATING",
      },
    });
    expect((await owner.get("/dailybrief/latest")).body).toMatchObject({
      id: brief.id,
      runId: firstRun.id,
      status: "EMPTY",
      content: null,
    });
    expect((await owner.get("/dashboard")).body.latestBrief.id).toBe(brief.id);
    expect((await owner.get(`/dailybrief/${brief.id}`)).status).toBe(200);
    expect((await other.get(`/dailybrief/${brief.id}`)).status).toBe(404);
    expect((await other.get("/dailybrief/latest")).body).toBeNull();
    expect((await other.get("/dashboard")).body.latestBrief).toBeNull();
    const response = (await owner.get("/dailybrief/latest")).body;
    expect(response).not.toHaveProperty("userId");
    expect(response).not.toHaveProperty("interestPrompt");
  });
  test("paginates saved brief summaries on the server and isolates membership", async () => {
    const source = await db.source.create({
      data: { userId: users[0]!, type: "RSS", url: "https://brief.example/feed" },
    });
    const articleIds: string[] = [];
    for (let index = 0; index < 7; index++) {
      const article = await db.article.create({
        data: {
          userId: users[0]!,
          sourceId: source.id,
          title: `Article ${index}`,
          summary: `Résumé ${index}`,
          keyPoints: ["Fait"],
          url: "https://brief.example/notice",
          contentUrl: `https://journal.example/${index}`,
          content: "Le texte intégral doit rester au serveur.",
          contentHash: randomUUID(),
          fingerprint: randomUUID(),
          publishedAt: new Date(`2026-10-11T0${index}:00:00Z`),
        },
      });
      articleIds.push(article.id);
    }
    const run = await db.dailyBriefRun.create({ data: { userId: users[0]! } });
    const brief = await db.dailyBrief.create({
      data: {
        userId: users[0]!,
        runId: run.id,
        date: "2026-10-12",
        timezone: "Europe/Paris",
        status: "READY",
        articleIds,
        articleCount: 7,
      },
    });
    const first = await owner.get(`/dailybrief/${brief.id}/articles?page=1`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 7, page: 1, pageSize: 5 });
    expect(first.body.articles).toHaveLength(5);
    expect(first.body.articles[0]).toMatchObject({
      title: "Article 6",
      url: "https://journal.example/6",
      summary: "Résumé 6",
    });
    expect(first.body.articles[0]).not.toHaveProperty("content");
    const last = await owner.get(`/dailybrief/${brief.id}/articles?page=99`);
    expect(last.body).toMatchObject({ total: 7, page: 2 });
    expect(last.body.articles).toHaveLength(2);
    expect(
      new Set([...first.body.articles, ...last.body.articles].map((item) => item.id)).size,
    ).toBe(7);
    expect((await other.get(`/dailybrief/${brief.id}/articles`)).status).toBe(404);
    expect((await owner.get(`/dailybrief/${brief.id}/articles?page=0`)).status).toBe(400);
    expect((await owner.get(`/dailybrief/${brief.id}/articles?userId=${users[1]}`)).status).toBe(
      400,
    );
  });
});
