import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, db, connect, disconnect } from "./helpers";

describe("server-side source pagination", () => {
  const reader = request.agent(app);
  const otherReader = request.agent(app);
  const prefix = randomUUID();
  let userId = "";
  let otherId = "";
  const sourceId = (index: number) => `${prefix}-${String(index).padStart(2, "0")}`;
  beforeAll(async () => {
    await connect();
    const password = "Password123456";
    const passwordHash = await Bun.password.hash(password);
    for (const [agent, suffix] of [
      [reader, "reader"],
      [otherReader, "other"],
    ] as const) {
      const email = `${prefix}-${suffix}@example.test`;
      const user = await db.user.create({ data: { email, passwordHash } });
      if (suffix === "reader") userId = user.id;
      else otherId = user.id;
      expect((await agent.post("/auth/login").send({ email, password })).status).toBe(200);
    }
    await db.source.create({
      data: { userId: otherId, url: "https://news.example/feeds/100", type: "RSS" },
    });
  });
  beforeEach(async () => {
    await db.source.deleteMany({ where: { userId } });
    await db.source.createMany({
      data: Array.from({ length: 15 }, (_, index) => ({
        id: sourceId(index + 1),
        userId,
        url: `https://news.example/${index < 11 ? "feeds" : "scraping"}/${index + 1}`,
        type: index < 11 ? ("RSS" as const) : ("SCRAPING" as const),
        enabled: index % 2 === 0,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
      })),
    });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await disconnect();
  });

  test("bounds the default response and returns only the public source fields", async () => {
    const response = await reader.get("/sources");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 15, page: 1, pageSize: 5 });
    expect(response.body.sources).toHaveLength(5);
    expect(response.body.sources.map((source: { id: string }) => source.id)).toEqual(
      [15, 14, 13, 12, 11].map(sourceId),
    );
    expect(Object.keys(response.body.sources[0]).sort()).toEqual([
      "articleLinkSelector",
      "enabled",
      "id",
      "scrapingConfig",
      "type",
      "url",
    ]);
  });

  test("paginates RSS in stable order without duplicates and clamps missing pages", async () => {
    const pages = await Promise.all(
      [1, 2, 3].map((page) => reader.get("/sources").query({ type: "RSS", page })),
    );
    expect(pages.map((response) => response.body.sources.length)).toEqual([5, 5, 1]);
    const ids = pages.flatMap((response) =>
      response.body.sources.map((source: { id: string }) => source.id),
    );
    expect(ids).toEqual(Array.from({ length: 11 }, (_, index) => sourceId(11 - index)));
    expect(new Set(ids).size).toBe(11);
    const clamped = await reader.get("/sources").query({ type: "RSS", page: 1000000 });
    expect(clamped.body).toMatchObject({ total: 11, page: 3, pageSize: 5 });
    expect(clamped.body.sources).toHaveLength(1);
    await db.source.update({
      where: { id: sourceId(10) },
      data: { createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 10)) },
    });
    const tied = await reader.get("/sources").query({ type: "RSS" });
    expect(tied.body.sources.slice(0, 2).map((source: { id: string }) => source.id)).toEqual([
      sourceId(11),
      sourceId(10),
    ]);
  });

  test("combines type, literal URL search and status before counting and paging", async () => {
    const active = await reader
      .get("/sources")
      .query({ type: "RSS", status: "active", q: "  NEWS.EXAMPLE/FEEDS/1  ", page: 2 });
    expect(active.body).toMatchObject({ total: 2, page: 1, pageSize: 5 });
    expect(active.body.sources.map((source: { id: string }) => source.id)).toEqual([
      sourceId(11),
      sourceId(1),
    ]);
    const inactive = await reader
      .get("/sources")
      .query({ type: "RSS", status: "inactive", q: "feeds/1" });
    expect(inactive.body.total).toBe(1);
    expect(inactive.body.sources[0].id).toBe(sourceId(10));
    const scraping = await reader.get("/sources").query({ type: "SCRAPING", status: "active" });
    expect(scraping.body.total).toBe(2);
    expect(scraping.body.sources.map((source: { id: string }) => source.id)).toEqual([
      sourceId(15),
      sourceId(13),
    ]);
    const empty = await reader.get("/sources").query({ type: "RSS", q: "scraping", page: 3 });
    expect(empty.body).toEqual({ sources: [], total: 0, page: 1, pageSize: 5 });
  });

  test("treats SQL LIKE wildcard and escape characters as literal text", async () => {
    const urls = [
      "https://news.example/literal%value",
      "https://news.example/literal_value",
      "https://news.example/literalXvalue",
    ];
    await db.source.createMany({ data: urls.map((url) => ({ userId, type: "RSS", url })) });
    for (const [q, url] of [
      ["%", urls[0]],
      ["_", urls[1]],
    ] as const) {
      const response = await reader.get("/sources").query({ q });
      expect(response.body.total).toBe(1);
      expect(response.body.sources.map((source: { url: string }) => source.url)).toEqual([url]);
    }
    const backslash = await reader.get("/sources").query({ q: "\\" });
    expect(backslash.status).toBe(200);
    expect(backslash.body.total).toBe(0);
  });

  test("isolates rows and counts between users and requires a session", async () => {
    expect((await request(app).get("/sources")).status).toBe(401);
    const mine = await reader.get("/sources").query({ type: "RSS", q: "feeds/1" });
    expect(mine.body.total).toBe(3);
    expect(mine.body.sources.every((source: { id: string }) => source.id.startsWith(prefix))).toBe(
      true,
    );
    const theirs = await otherReader.get("/sources").query({ type: "RSS", q: "feeds/1" });
    expect(theirs.body.total).toBe(1);
    expect(theirs.body.sources[0].url).toBe("https://news.example/feeds/100");
    expect((await reader.get("/sources").query({ userId: otherId })).status).toBe(400);
  });

  test("rejects invalid or duplicate criteria rather than returning an unbounded list", async () => {
    const invalid = [
      "page=0",
      "page=-1",
      "page=1.5",
      "page=1000001",
      "page=NaN",
      "page=01",
      "page=1&page=2",
      "type=XML",
      "type=RSS&type=SCRAPING",
      "status=enabled",
      "limit=9999",
      "q=a&q=b",
    ];
    for (const query of invalid) expect((await reader.get(`/sources?${query}`)).status).toBe(400);
    expect((await reader.get("/sources").query({ q: "x".repeat(2001) })).status).toBe(400);
  });

  test("returns the last remaining page after a deletion", async () => {
    expect((await reader.delete(`/sources/${sourceId(1)}`)).status).toBe(204);
    const response = await reader.get("/sources").query({ type: "RSS", page: 3 });
    expect(response.body).toMatchObject({ total: 10, page: 2, pageSize: 5 });
    expect(response.body.sources.map((source: { id: string }) => source.id)).toEqual(
      [6, 5, 4, 3, 2].map(sourceId),
    );
  });
});
