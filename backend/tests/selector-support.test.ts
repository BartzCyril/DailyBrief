import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import type { SelectorAnalysisInput } from "@dailybrief/shared";
import { readConfig } from "../src/config";
import { AppError } from "../src/errors";
import { createRedis, type Redis } from "../src/redis";
import {
  sanitizeAssistanceUrl,
  SelectorHelpService,
  SmtpSelectorHelpSender,
  type SelectorHelpMessage,
  type SelectorHelpSender,
} from "../src/selector-support";

const config = readConfig({
  DATABASE_URL: "postgresql://localhost/selector_support_test",
  REDIS_URL: process.env.REDIS_URL,
  SESSION_SECRET: "s".repeat(32),
  SMTP_USER: "support@example.com",
  SMTP_PASSWORD: "private-smtp-password",
});

test("assistance URLs remove query tokens, fragments and URL credentials", () => {
  expect(
    sanitizeAssistanceUrl(
      "https://private-user:private-password@Example.com/news?id=private-token#private-fragment",
    ),
  ).toBe("https://example.com/news");
  expect(sanitizeAssistanceUrl("https://example.com:8443/login")).toBe(
    "https://example.com:8443/login",
  );
  expect(() => sanitizeAssistanceUrl("file:///etc/passwd")).toThrow("HTTP ou HTTPS");
  expect(() => sanitizeAssistanceUrl("not an address")).toThrow("invalide");
});

test("SMTP transport uses SMTP_USER, server reply-to, stable ID and no remote or file access", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const spy = spyOn(transport, "sendMail");
  try {
    await new SmtpSelectorHelpSender(config, transport).send({
      to: "ignored-arbitrary-address@example.com",
      replyTo: "account@example.com",
      subject: "DailyBrief — aide",
      text: "Sélecteur du titre à trouver.",
      messageId: "<stable-help-id@dailybrief.local>",
    });
    expect(spy).toHaveBeenCalledWith({
      from: config.SMTP_FROM,
      to: config.SMTP_USER,
      replyTo: "account@example.com",
      subject: "DailyBrief — aide",
      text: "Sélecteur du titre à trouver.",
      messageId: "<stable-help-id@dailybrief.local>",
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } finally {
    spy.mockRestore();
  }
});

test("only explicit SMTP rejections are retryable; DATA and CONN timeouts remain uncertain", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const spy = spyOn(transport, "sendMail");
  const sender = new SmtpSelectorHelpSender(config, transport);
  const message = {
    to: config.SMTP_USER!,
    replyTo: "account@example.com",
    subject: "Aide",
    text: "Texte",
  };
  try {
    for (const detail of [
      { command: "DATA" },
      { command: "CONN", code: "ETIMEDOUT" },
      { command: "CONN", code: "ESOCKET" },
      { code: "ECONNRESET" },
      { command: "DATA", code: "ETIMEDOUT", responseCode: 250 },
      { command: "CONN" },
    ]) {
      spy.mockImplementation(() => {
        throw Object.assign(new Error("private upstream response"), detail);
      });
      await assert.rejects(sender.send(message), { code: "SMTP_UNCERTAIN", status: 502 });
    }
    for (const responseCode of [421, 450, 550]) {
      spy.mockImplementation(() => {
        throw Object.assign(new Error("private upstream response"), {
          command: "DATA",
          responseCode,
        });
      });
      await assert.rejects(sender.send(message), { code: "SMTP_FAILED", status: 503 });
    }
  } finally {
    spy.mockRestore();
  }
});

describe("selector assistance contexts in Redis", () => {
  const redis = createRedis(config.REDIS_URL);
  const users: string[] = [];
  const user = () => {
    const id = `selector-help-test-${randomUUID()}`;
    users.push(id);
    return id;
  };
  const key = (userId: string, id: string) =>
    `dailybrief:selector-help:user:${encodeURIComponent(userId)}:${id}`;
  const recordingSender = () => {
    const messages: SelectorHelpMessage[] = [];
    const sender: SelectorHelpSender = {
      async send(message) {
        messages.push(message);
      },
    };
    return { messages, sender };
  };

  beforeAll(async () => {
    redis.on("error", () => {});
    await redis.connect();
  });
  afterAll(async () => {
    for (const id of users) {
      const keys = await redis.keys(`dailybrief:selector-help:user:${encodeURIComponent(id)}:*`);
      if (keys.length) await redis.del(keys);
    }
    await redis.quit();
  });

  test("creating a context sends nothing and stores only safe fields with a one-hour TTL", async () => {
    const { sender, messages } = recordingSender();
    const service = new SelectorHelpService(redis, config, sender);
    const userId = user();
    const input = {
      kind: "RSS_LINK",
      url: "https://private-user:private-password@feed.example.com/rss?token=private-token#private-fragment",
      password: "private-input-password",
      email: "private-input-email@example.com",
      html: "<input value='private-dom-value'>",
    } as SelectorAnalysisInput;
    const id = await service.create(
      userId,
      input,
      ["articleLinkSelector", "private-field-value"],
      "https://private-notice-user:private-notice-password@notice.example.com/123?key=private-notice-token#private-notice-fragment",
      "private-unrecognized-reason",
    );
    expect(id).toMatch(/^[a-f\d-]{36}$/);
    expect(messages).toHaveLength(0);
    const raw = (await redis.get(key(userId, id)))!;
    expect(JSON.parse(raw)).toEqual({
      kind: "RSS_LINK",
      url: "https://feed.example.com/rss",
      analyzedUrl: "https://notice.example.com/123",
      missingFields: ["articleLinkSelector"],
      reasonCode: "SELECTOR_ANALYSIS_FAILED",
      state: "pending",
    });
    expect(raw).not.toContain("private-");
    expect(await redis.ttl(key(userId, id))).toBeGreaterThan(3590);
    expect(await redis.ttl(key(userId, id))).toBeLessThanOrEqual(3600);
  });

  test("email explains the site and missing selectors in French, with only the server account as reply-to", async () => {
    const { sender, messages } = recordingSender();
    const service = new SelectorHelpService(redis, config, sender);
    const userId = user();
    const id = await service.create(
      userId,
      { kind: "RSS_LINK", url: "https://feed.example.com/rss?secret=private-token" },
      ["articleLinkSelector"],
      "https://notice.example.com/article#private-fragment",
      "AI_TIMEOUT",
    );
    expect(await service.send(userId, "account@example.com", id)).toEqual({
      message: "La demande d’aide a été envoyée.",
    });
    expect(messages).toHaveLength(1);
    const mail = messages[0]!;
    expect(mail.to).toBe(config.SMTP_USER!);
    expect(mail.replyTo).toBe("account@example.com");
    expect(mail.messageId).toBe(`<selector-help-${id}@dailybrief.local>`);
    expect(mail.text).toContain("Demandeur : account@example.com");
    expect(mail.text).toContain("Flux ou notice RSS : https://feed.example.com/rss");
    expect(mail.text).toContain("Page analysée : https://notice.example.com/article");
    expect(mail.text).toContain("Lien de la notice qui mène à l’article");
    expect(mail.text).toContain("Le service IA a dépassé son délai de réponse.");
    expect(mail.text).not.toContain("private-");
    expect(mail.text).not.toContain(config.SMTP_PASSWORD!);
    expect(mail.text).not.toContain("Champ de mot de passe");
  });

  test("each configuration kind has a useful selector checklist when analysis failed completely", async () => {
    const { sender, messages } = recordingSender();
    const service = new SelectorHelpService(redis, config, sender);
    const userId = user();
    for (const kind of ["SCRAPING", "JOURNAL_LOGIN"] as const) {
      const id = await service.create(userId, { kind, url: "https://example.com/page" });
      await service.send(userId, "account@example.com", id);
    }
    expect(messages[0]!.text).toContain("Bloc répété contenant chaque article");
    expect(messages[0]!.text).toContain("Titre, à l’intérieur de chaque bloc");
    expect(messages[0]!.text).toContain("Lien vers l’article");
    expect(messages[1]!.text).toContain("Champ d’identifiant ou d’email");
    expect(messages[1]!.text).toContain("Champ de mot de passe");
    expect(messages[1]!.text).toContain("Bouton qui envoie le formulaire");
    expect(messages[1]!.text).toContain("Élément visible uniquement après une connexion réussie");
  });

  test("partial login assistance identifies only the unverified success selector", async () => {
    const { sender, messages } = recordingSender();
    const service = new SelectorHelpService(redis, config, sender);
    const userId = user();
    const id = await service.create(
      userId,
      { kind: "JOURNAL_LOGIN", url: "https://journal.example.com/login" },
      ["successSelector", "successSelector"],
      "https://journal.example.com/login?private-token=123",
      "SELECTOR_ANALYSIS_PARTIAL",
    );
    await service.send(userId, "account@example.com", id);
    expect(messages[0]!.text).toContain("Page de connexion : https://journal.example.com/login");
    expect(messages[0]!.text).not.toContain("Page analysée");
    expect(messages[0]!.text).toContain("une partie des informations seulement");
    expect(messages[0]!.text).not.toContain("Champ de mot de passe");
    expect(messages[0]!.text.match(/Élément visible uniquement/g)).toHaveLength(1);
  });

  test("context identifiers cannot be replayed by another user or used after expiry", async () => {
    const { sender, messages } = recordingSender();
    const service = new SelectorHelpService(redis, config, sender);
    const owner = user();
    const stranger = user();
    const id = await service.create(owner, { kind: "SCRAPING", url: "https://example.com/news" });
    await assert.rejects(service.send(stranger, "stranger@example.com", id), {
      code: "SELECTOR_HELP_EXPIRED",
      status: 404,
    });
    await assert.rejects(service.send(owner, "account@example.com", randomUUID()), {
      code: "SELECTOR_HELP_EXPIRED",
    });
    await assert.rejects(service.send(owner, "account@example.com", "../../another-key"), {
      code: "SELECTOR_HELP_EXPIRED",
    });
    expect(messages).toHaveLength(0);
    await redis.pExpire(key(owner, id), 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(service.send(owner, "account@example.com", id), {
      code: "SELECTOR_HELP_EXPIRED",
    });
    expect(messages).toHaveLength(0);
  });

  test("SMTP_USER must be an email and failed configuration does not consume the request", async () => {
    const { sender, messages } = recordingSender();
    const userId = user();
    const service = new SelectorHelpService(redis, config, sender);
    const id = await service.create(userId, { kind: "RSS_LINK", url: "https://example.com/feed" });
    for (const SMTP_USER of [undefined, "smtp-account-login", ""]) {
      const invalidService = new SelectorHelpService(redis, { ...config, SMTP_USER }, sender);
      await assert.rejects(invalidService.send(userId, "account@example.com", id), {
        code: "SMTP_USER_INVALID",
        status: 503,
        message:
          "L’envoi d’aide nécessite une adresse email valide dans SMTP_USER. Contactez l’administrateur.",
      });
    }
    expect(messages).toHaveLength(0);
    expect(JSON.parse((await redis.get(key(userId, id)))!).state).toBe("pending");
    await service.send(userId, "account@example.com", id);
    expect(messages).toHaveLength(1);
  });

  test("concurrent clicks and replay of a completed request send only one email", async () => {
    let resolveSend = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const messages: SelectorHelpMessage[] = [];
    const service = new SelectorHelpService(redis, config, {
      async send(message) {
        messages.push(message);
        markStarted();
        await waiting;
      },
    });
    const userId = user();
    const id = await service.create(userId, { kind: "SCRAPING", url: "https://example.com/news" });
    const pending = service.send(userId, "account@example.com", id);
    await started;
    await assert.rejects(service.send(userId, "account@example.com", id), {
      code: "SELECTOR_HELP_RUNNING",
      status: 409,
    });
    expect(messages).toHaveLength(1);
    resolveSend();
    const acknowledgement = await pending;
    expect(await service.send(userId, "account@example.com", id)).toEqual(acknowledgement);
    expect(messages).toHaveLength(1);
    expect(await redis.exists(`${key(userId, id)}:sending`)).toBe(0);
    expect(await redis.ttl(key(userId, id))).toBeGreaterThan(3590);
  });

  test("an explicit SMTP rejection allows a later click to retry with the same message ID", async () => {
    const messages: SelectorHelpMessage[] = [];
    let fails = true;
    const service = new SelectorHelpService(redis, config, {
      async send(message) {
        messages.push(message);
        if (fails) throw new AppError(503, "SMTP rejected", "SMTP_FAILED");
      },
    });
    const userId = user();
    const id = await service.create(userId, { kind: "SCRAPING", url: "https://example.com/news" });
    await assert.rejects(service.send(userId, "account@example.com", id), { code: "SMTP_FAILED" });
    expect(JSON.parse((await redis.get(key(userId, id)))!).state).toBe("pending");
    expect(await redis.exists(`${key(userId, id)}:sending`)).toBe(0);
    fails = false;
    await service.send(userId, "account@example.com", id);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.messageId).toBe(messages[1]!.messageId);
    expect(messages[0]!.text).toBe(messages[1]!.text);
    await service.send(userId, "account@example.com", id);
    expect(messages).toHaveLength(2);
  });

  test("uncertain delivery and unknown sender failures never trigger a second email", async () => {
    let calls = 0;
    for (const failure of [
      new AppError(502, "uncertain", "SMTP_UNCERTAIN"),
      new Error("private transport detail"),
    ]) {
      const service = new SelectorHelpService(redis, config, {
        async send() {
          calls++;
          throw failure;
        },
      });
      const userId = user();
      const id = await service.create(userId, {
        kind: "RSS_LINK",
        url: "https://example.com/feed",
      });
      const before = calls;
      await assert.rejects(service.send(userId, "account@example.com", id), {
        code: "SMTP_UNCERTAIN",
        status: 502,
      });
      expect(JSON.parse((await redis.get(key(userId, id)))!).state).toBe("uncertain");
      await assert.rejects(service.send(userId, "account@example.com", id), {
        code: "SMTP_UNCERTAIN",
      });
      expect(calls).toBe(before + 1);
    }
  });

  test("a Nodemailer CONN timeout after submission records uncertainty and blocks another send", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const spy = spyOn(transport, "sendMail");
    try {
      spy.mockImplementation(() => {
        throw Object.assign(new Error("private socket timeout detail"), {
          code: "ETIMEDOUT",
          command: "CONN",
        });
      });
      const service = new SelectorHelpService(
        redis,
        config,
        new SmtpSelectorHelpSender(config, transport),
      );
      const userId = user();
      const id = await service.create(userId, {
        kind: "SCRAPING",
        url: "https://example.com/news",
      });
      await assert.rejects(service.send(userId, "account@example.com", id), {
        code: "SMTP_UNCERTAIN",
      });
      expect(JSON.parse((await redis.get(key(userId, id)))!).state).toBe("uncertain");
      await assert.rejects(service.send(userId, "account@example.com", id), {
        code: "SMTP_UNCERTAIN",
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("an interrupted send whose lock expired becomes uncertain rather than being resent", async () => {
    const { sender, messages } = recordingSender();
    const service = new SelectorHelpService(redis, config, sender);
    const userId = user();
    const id = await service.create(userId, {
      kind: "JOURNAL_LOGIN",
      url: "https://example.com/login",
    });
    const context = JSON.parse((await redis.get(key(userId, id)))!);
    await redis.set(
      key(userId, id),
      JSON.stringify({ ...context, state: "sending", token: "expired-owner" }),
      { KEEPTTL: true },
    );
    await assert.rejects(service.send(userId, "account@example.com", id), {
      code: "SMTP_UNCERTAIN",
    });
    expect(messages).toHaveLength(0);
    expect(JSON.parse((await redis.get(key(userId, id)))!).state).toBe("uncertain");
  });

  test("if Redis fails after delivery, later calls cannot resend an email with an unknown outcome", async () => {
    const { sender, messages } = recordingSender();
    let evalCalls = 0;
    const interruptedRedis = new Proxy(redis, {
      get(target, property) {
        if (property === "eval")
          return (...args: Parameters<Redis["eval"]>) => {
            evalCalls++;
            if (evalCalls === 2) return Promise.reject(new Error("Redis unavailable"));
            return target.eval(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Redis;
    const userId = user();
    const service = new SelectorHelpService(interruptedRedis, config, sender);
    const id = await service.create(userId, { kind: "SCRAPING", url: "https://example.com/news" });
    await assert.rejects(service.send(userId, "account@example.com", id), {
      code: "SMTP_UNCERTAIN",
    });
    expect(messages).toHaveLength(1);
    await assert.rejects(service.send(userId, "account@example.com", id), {
      code: "SELECTOR_HELP_RUNNING",
    });
    await redis.del(`${key(userId, id)}:sending`);
    await assert.rejects(service.send(userId, "account@example.com", id), {
      code: "SMTP_UNCERTAIN",
    });
    expect(messages).toHaveLength(1);
  });
});
