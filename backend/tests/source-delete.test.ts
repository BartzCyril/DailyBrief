import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { db, redis, config, connect, disconnect } from "./helpers";

describe("source deletion", () => {
  const app = createApp(db, redis, config);
  const agent = request.agent(app);
  let userId = "";
  let sourceId = "";
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    const email = `delete-${randomUUID()}@example.test`;
    const user = await db.user.create({
      data: { email, passwordHash: await Bun.password.hash("Password123456") },
    });
    userId = user.id;
    const source = await db.source.create({
      data: { userId, type: "RSS", url: "https://fixture.example/feed" },
    });
    sourceId = source.id;
    await agent.post("/auth/login").send({ email, password: "Password123456" });
  });
  afterEach(async () => {
    await db.user.delete({ where: { id: userId } });
  });
  test("requires authentication and ownership, and returns not found for missing sources", async () => {
    expect((await request(app).delete(`/sources/${sourceId}`)).status).toBe(401);
    const other = await db.user.create({
      data: { email: `other-delete-${randomUUID()}@example.test`, passwordHash: "unused" },
    });
    try {
      const otherSource = await db.source.create({
        data: { userId: other.id, type: "RSS", url: "https://fixture.example/other" },
      });
      expect(
        (await agent.delete(`/sources/${otherSource.id}`).send({ userId: other.id })).status,
      ).toBe(404);
      expect((await agent.delete("/sources/missing")).status).toBe(404);
      expect(await db.source.count({ where: { id: { in: [sourceId, otherSource.id] } } })).toBe(2);
    } finally {
      await db.user.delete({ where: { id: other.id } });
    }
  });
  test("removes RSS and scraping sources and their dependent articles without deleting other sources or newsletters", async () => {
    const otherSource = await db.source.create({
      data: {
        userId,
        type: "SCRAPING",
        url: "https://fixture.example/news",
        enabled: false,
        scrapingConfig: {
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "a",
          mode: "SCROLL",
          scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
        },
      },
    });
    const createArticle = (id: string) =>
      db.article.create({
        data: {
          userId,
          sourceId: id,
          title: "Article",
          fingerprint: randomUUID(),
          contentHash: randomUUID(),
          summary: "Résumé",
        },
      });
    const deletedArticle = await createArticle(sourceId);
    const retainedArticle = await createArticle(otherSource.id);
    const newsletter = await db.newsletter.create({
      data: {
        userId,
        status: "SENT",
        recipientEmail: "recipient@example.test",
        subject: "Newsletter",
        articles: { create: [{ articleId: deletedArticle.id }, { articleId: retainedArticle.id }] },
      },
    });
    expect((await agent.delete(`/sources/${sourceId}`)).status).toBe(204);
    expect(await db.source.findUnique({ where: { id: sourceId } })).toBeNull();
    expect(await db.article.findUnique({ where: { id: deletedArticle.id } })).toBeNull();
    expect(await db.article.findUnique({ where: { id: retainedArticle.id } })).toEqual(
      retainedArticle,
    );
    expect(await db.source.findUnique({ where: { id: otherSource.id } })).toEqual(otherSource);
    expect(
      (await agent.get("/sources")).body.sources.map((source: { id: string }) => source.id),
    ).toEqual([otherSource.id]);
    expect(await db.newsletterArticle.count({ where: { newsletterId: newsletter.id } })).toBe(1);
    expect((await agent.delete(`/sources/${sourceId}`)).status).toBe(404);
    expect((await agent.delete(`/sources/${otherSource.id}`)).status).toBe(204);
    expect(await db.source.count({ where: { userId } })).toBe(0);
    expect(await db.article.count({ where: { userId } })).toBe(0);
    expect(await db.newsletter.findUnique({ where: { id: newsletter.id } })).toEqual(newsletter);
    expect(await db.newsletterArticle.count({ where: { newsletterId: newsletter.id } })).toBe(0);
  });
});
