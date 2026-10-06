import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { parseRss, RssService } from "../src/rss";
import { isPublicAddress, validateRemoteUrl } from "../src/network";
import { createApp } from "../src/app";
import { config, db, redis, connect, disconnect } from "./helpers";
const xml = `<rss version="2.0"><channel><title>Actualités</title><item><title>Premier</title><link>https://example.com/1</link><guid>one</guid><description><![CDATA[<p>Bonjour</p>]]></description><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate></item><item><title>Deuxième</title></item></channel></rss>`;
test("parses RSS with normalized dates, text, GUID and absent fields", () => {
  const result = parseRss(xml, "https://example.com/feed");
  expect(result.articles).toHaveLength(2);
  expect(result.articles[0]).toMatchObject({
    title: "Premier",
    description: "Bonjour",
    guid: "one",
    publishedAt: "2026-10-06T10:00:00.000Z",
  });
  expect(result.articles[1]?.url).toBeNull();
});
test("parses Atom alternate links", () => {
  expect(
    parseRss(
      '<feed><title>Atom</title><entry><title>Article</title><id>id1</id><link rel="alternate" href="/article"/></entry></feed>',
      "https://example.com/feed",
    ).articles[0]?.url,
  ).toBe("https://example.com/article");
});
test("rejects invalid XML, entity declarations, non feeds and empty feeds", () => {
  for (const value of [
    "<rss>",
    "<html></html>",
    "<rss><channel/></rss>",
    '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel/></rss>',
  ])
    expect(() => parseRss(value, "https://example.com")).toThrow();
});
test("blocks private IPv4, IPv6 and mapped addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  for (const url of [
    "http://127.0.0.1",
    "http://[::1]",
    "file:///etc/passwd",
    "http://2130706433",
    "http://user:pass@example.com",
  ])
    await expect(validateRemoteUrl(url)).rejects.toThrow();
});
describe("RSS source ownership", () => {
  const email = `rss-${randomUUID()}@example.com`;
  const otherEmail = `other-${randomUUID()}@example.com`;
  const app = createApp(db, redis, config, {
    rss: new RssService(async (url) => {
      if (url.includes("broken")) throw new Error("unreachable");
      return xml;
    }),
  });
  const agent = request.agent(app);
  let userId = "";
  beforeAll(async () => {
    await connect();
    const user = await db.user.create({
      data: { email, passwordHash: await Bun.password.hash("Password123456") },
    });
    userId = user.id;
    const other = await db.user.create({ data: { email: otherEmail, passwordHash: "unused" } });
    await db.source.create({
      data: { userId: other.id, type: "RSS", url: "https://example.com/other" },
    });
    await agent.post("/auth/login").send({ email, password: "Password123456" });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    await disconnect();
  });
  test("requires authentication", async () => {
    expect(
      (await request(app).post("/sources/rss/test").send({ url: "https://example.com" })).status,
    ).toBe(401);
  });
  test("previews without saving and validates URL", async () => {
    expect((await agent.post("/sources/rss/test").send({ url: "bad" })).status).toBe(400);
    const response = await agent
      .post("/sources/rss/test")
      .send({ url: "https://example.com/feed" });
    expect(response.status).toBe(200);
    expect(response.body.articles).toHaveLength(2);
    expect(await db.source.count({ where: { userId } })).toBe(0);
  });
  test("creates a source only for the session user with null scraping config", async () => {
    expect(
      (
        await agent
          .post("/sources")
          .send({ type: "RSS", url: "https://example.com/feed", userId: "attacker" })
      ).status,
    ).toBe(400);
    const response = await agent
      .post("/sources")
      .send({ type: "RSS", url: "https://example.com/feed" });
    expect(response.status).toBe(201);
    expect(response.body.userId).toBe(userId);
    expect(response.body.scrapingConfig).toBeNull();
  });
  test("rejects duplicate sources", async () => {
    expect(
      (await agent.post("/sources").send({ type: "RSS", url: "https://example.com/feed" })).status,
    ).toBe(409);
  });
  test("lists only current user's sources", async () => {
    const response = await agent.get("/sources");
    expect(response.body).toHaveLength(1);
    expect(response.body[0].userId).toBe(userId);
  });
  test("hides upstream errors", async () => {
    const response = await agent
      .post("/sources/rss/test")
      .send({ url: "https://example.com/broken" });
    expect(response.status).toBe(500);
    expect(response.body.message).not.toContain("unreachable");
  });
});
