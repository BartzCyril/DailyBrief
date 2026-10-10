import { beforeAll, afterAll, beforeEach, afterEach, test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { SelectorAnalysisInput, SelectorAnalysisResult } from "@dailybrief/shared";
import { createApp } from "../src/app";
import { AppError, UpstreamHttpError } from "../src/errors";
import { SelectorAnalysisFailure } from "../src/selector-analysis";
import type { SelectorHelpMessage } from "../src/selector-support";
import { config, db, redis, connect, disconnect } from "./helpers";

let failure: Error | undefined;
let mailFailure = false;
const analyses: SelectorAnalysisInput[] = [];
const messages: SelectorHelpMessage[] = [];
const provider = {
  async analyze(input: SelectorAnalysisInput): Promise<SelectorAnalysisResult> {
    analyses.push(input);
    if (failure) throw failure;
    const common = {
      analyzedUrl: "https://news.example/page",
      complete: true,
      missingFields: [],
      message: "Sélecteurs vérifiés.",
    };
    if (input.kind === "SCRAPING")
      return {
        ...common,
        kind: "SCRAPING",
        scrapingConfig: {
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "a",
          mode: "SCROLL",
          scroll: { maxScrolls: 0, waitAfterScrollMs: 300 },
        },
      };
    if (input.kind === "RSS_LINK")
      return {
        ...common,
        kind: "RSS_LINK",
        analyzedUrl: "https://library.example/notice",
        articleLinkSelector: "a.primarydoc",
      };
    return {
      ...common,
      kind: "JOURNAL_LOGIN",
      complete: false,
      missingFields: ["successSelector"],
      loginConfig: {
        loginUrl: "https://news.example/login",
        emailSelector: "#email",
        passwordSelector: "#password",
        submitSelector: "button[type=submit]",
      },
    };
  },
};
function application(user: string | undefined = "smtp-owner@example.test") {
  return createApp(
    db,
    redis,
    { ...config, SMTP_USER: user },
    {
      selectorAnalysis: provider,
      selectorHelpSender: {
        async send(message) {
          if (mailFailure) throw new AppError(503, "L'envoi SMTP a échoué.", "SMTP_FAILED");
          messages.push(message);
        },
      },
      summary: {
        async summarize() {
          throw new Error("No summaries permitted");
        },
      },
      email: {
        async send() {
          throw new Error("No newsletters permitted");
        },
      },
    },
  );
}
const app = application();
let agent = request.agent(app);
let userId = "",
  email = "";
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  failure = undefined;
  mailFailure = false;
  analyses.length = messages.length = 0;
  email = `selector-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { email, passwordHash: await Bun.password.hash("Password123456") },
  });
  userId = user.id;
  agent = request.agent(app);
  await agent.post("/auth/login").send({ email, password: "Password123456" }).expect(200);
});
afterEach(async () => {
  const keys = await redis.keys(`dailybrief:selector-help:*${userId}*`);
  if (keys.length) await redis.del(keys);
  await db.user.deleteMany({ where: { id: userId } });
});
const input = { kind: "SCRAPING", url: "https://news.example" };

test("requires authentication and rejects extra credential or recipient fields before analysis", async () => {
  await request(app).post("/ai/selectors/analyze").send(input).expect(401);
  for (const body of [
    { ...input, password: "must-not-be-forwarded" },
    { ...input, kind: "UNKNOWN" },
    { ...input, url: "file:///etc/passwd" },
    { ...input, url: "https://user:secret@news.example" },
  ])
    await agent.post("/ai/selectors/analyze").send(body).expect(400);
  assert.equal(analyses.length, 0);
  await agent
    .post("/ai/selectors/help")
    .send({ helpRequestId: randomUUID(), to: "arbitrary@example.test" })
    .expect(400);
  assert.equal(messages.length, 0);
});

test("returns scraping and RSS suggestions without changing sources, articles or newsletters or sending mail", async () => {
  for (const kind of ["SCRAPING", "RSS_LINK"]) {
    const response = await agent
      .post("/ai/selectors/analyze")
      .send({ ...input, kind })
      .expect(200);
    assert.equal(response.body.kind, kind);
    assert.equal(response.body.complete, true);
    assert.equal(response.body.helpRequestId, undefined);
  }
  assert.equal(await db.source.count({ where: { userId } }), 0);
  assert.equal(await db.article.count({ where: { userId } }), 0);
  assert.equal(await db.newsletter.count({ where: { userId } }), 0);
  assert.equal(messages.length, 0);
});

test("partial login suggestions create an isolated help context and send only on explicit request", async () => {
  const response = await agent
    .post("/ai/selectors/analyze")
    .send({ kind: "JOURNAL_LOGIN", url: "https://news.example/login?token=never-email#private" })
    .expect(200);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.loginConfig.successSelector, undefined);
  assert.equal(messages.length, 0);
  const helpRequestId = response.body.helpRequestId;
  const other = request.agent(app);
  const otherEmail = `other-${randomUUID()}@example.test`;
  const otherUser = await db.user.create({
    data: { email: otherEmail, passwordHash: await Bun.password.hash("Password123456") },
  });
  try {
    await other
      .post("/auth/login")
      .send({ email: otherEmail, password: "Password123456" })
      .expect(200);
    await other.post("/ai/selectors/help").send({ helpRequestId }).expect(404);
    assert.equal(messages.length, 0);
  } finally {
    await db.user.delete({ where: { id: otherUser.id } });
  }
  await agent.post("/ai/selectors/help").send({ helpRequestId }).expect(200);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.to, "smtp-owner@example.test");
  assert.equal(messages[0]!.replyTo, email);
  assert(messages[0]!.text.includes("https://news.example/login"));
  assert(!messages[0]!.text.includes("never-email"));
  assert(!messages[0]!.text.includes("#private"));
  assert(messages[0]!.text.includes("connexion"));
  await agent.post("/ai/selectors/help").send({ helpRequestId }).expect(200);
  assert.equal(messages.length, 1);
});

test("AI and page errors offer help with sanitized context and allow retry after SMTP failure", async () => {
  failure = new AppError(503, "Le service IA est indisponible.", "AI_UNAVAILABLE");
  const response = await agent.post("/ai/selectors/analyze").send(input).expect(503);
  assert.equal(response.body.code, "AI_UNAVAILABLE");
  assert.equal(messages.length, 0);
  mailFailure = true;
  await agent
    .post("/ai/selectors/help")
    .send({ helpRequestId: response.body.helpRequestId })
    .expect(503);
  assert.equal(messages.length, 0);
  mailFailure = false;
  await agent
    .post("/ai/selectors/help")
    .send({ helpRequestId: response.body.helpRequestId })
    .expect(200);
  assert.equal(messages.length, 1);
  assert(messages[0]!.text.includes("news.example"));
  failure = new UpstreamHttpError(403, "https://news.example/private?token=private-token");
  const blocked = await agent.post("/ai/selectors/analyze").send(input).expect(422);
  assert(blocked.body.helpRequestId);
  assert(!JSON.stringify(blocked.body).includes("private-token"));
});

test("refuses unknown requests and a SMTP_USER that is not an email address", async () => {
  await agent.post("/ai/selectors/help").send({ helpRequestId: randomUUID() }).expect(404);
  const noSmtp = request.agent(application("smtp-login-without-email"));
  await noSmtp.post("/auth/login").send({ email, password: "Password123456" }).expect(200);
  failure = new AppError(503, "IA indisponible", "AI_UNAVAILABLE");
  const response = await noSmtp.post("/ai/selectors/analyze").send(input).expect(503);
  const help = await noSmtp
    .post("/ai/selectors/help")
    .send({ helpRequestId: response.body.helpRequestId })
    .expect(503);
  assert.equal(help.body.code, "SMTP_USER_INVALID");
  assert.equal(messages.length, 0);
});

test("limits repeated analysis per user", async () => {
  for (let index = 0; index < 10; index++)
    await agent.post("/ai/selectors/analyze").send(input).expect(200);
  const limited = await agent.post("/ai/selectors/analyze").send(input).expect(429);
  assert.equal(limited.body.code, "SELECTOR_ANALYSIS_RATE_LIMIT");
  assert.equal(analyses.length, 10);
});

test("includes the actual public RSS notice when AI failed after loading the feed", async () => {
  failure = new SelectorAnalysisFailure(
    new AppError(503, "IA indisponible", "AI_UNAVAILABLE"),
    "https://library.example/notice?token=private-notice-token#private",
  );
  const response = await agent
    .post("/ai/selectors/analyze")
    .send({ kind: "RSS_LINK", url: "https://library.example/feed" })
    .expect(503);
  await agent
    .post("/ai/selectors/help")
    .send({ helpRequestId: response.body.helpRequestId })
    .expect(200);
  assert(messages[0]!.text.includes("https://library.example/feed"));
  assert(messages[0]!.text.includes("https://library.example/notice"));
  assert(!messages[0]!.text.includes("private-notice-token"));
});
