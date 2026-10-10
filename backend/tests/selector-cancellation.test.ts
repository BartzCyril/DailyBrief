import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { test } from "bun:test";
import express from "express";
import type { SelectorAnalysisInput, SelectorAnalysisResult } from "@dailybrief/shared";
import { OllamaClient } from "../src/ai";
import { readConfig } from "../src/config";
import type { Db } from "../src/db";
import { AppError } from "../src/errors";
import {
  OllamaSelectorAnalysisProvider,
  type PublicSelectorPage,
  type SelectorAnalysisProvider,
} from "../src/selector-analysis";
import { selectorAssistanceRouter } from "../src/selector-assistance";
import type { SelectorHelpService } from "../src/selector-support";

const config = readConfig({
  DATABASE_URL: "postgresql://localhost/test",
  SESSION_SECRET: "x".repeat(32),
  AI_CONCURRENCY: "1",
});
const input: SelectorAnalysisInput = { kind: "SCRAPING", url: "https://publisher.example/" };
const page: PublicSelectorPage = {
  html: '<main><article><h2>Premier article</h2><a href="/first">Lire</a></article><article><h2>Deuxième article</h2><a href="/second">Lire</a></article></main>',
  url: input.url,
};
const scrapingConfig = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  mode: "SCROLL" as const,
  scroll: { maxScrolls: 0, waitAfterScrollMs: 300 },
};
const result: SelectorAnalysisResult = {
  kind: "SCRAPING",
  analyzedUrl: page.url,
  complete: true,
  missingFields: [],
  scrapingConfig,
  message: "Sélecteurs vérifiés.",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function pendingResponse(signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function generatedResponse() {
  return new Response(JSON.stringify({ response: JSON.stringify(scrapingConfig), done: true }));
}

test("Ollama propagates caller cancellation without reporting an outage or timeout", async () => {
  const started = deferred<AbortSignal>();
  const controller = new AbortController();
  const client = new OllamaClient(config, async (_url, init) => {
    assert(init?.signal);
    started.resolve(init.signal);
    return pendingResponse(init.signal);
  });
  const pending = client.request(
    "/api/generate",
    { model: config.OLLAMA_MODEL },
    controller.signal,
  );
  const receivedSignal = await started.promise;
  const reason = new DOMException("Analysis cancelled", "AbortError");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert(receivedSignal.aborted);
});

test("an already cancelled Ollama call makes no network request and preserves its reason", async () => {
  let calls = 0;
  const controller = new AbortController();
  const reason = new Error("Caller stopped the analysis");
  controller.abort(reason);
  const client = new OllamaClient(config, async () => {
    calls++;
    return generatedResponse();
  });
  await assert.rejects(
    client.request("/api/generate", {}, controller.signal),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});

test("the Ollama deadline remains a timeout when the caller did not cancel", async () => {
  const controller = new AbortController();
  const client = new OllamaClient({ ...config, OLLAMA_TIMEOUT_MS: 20 }, async (_url, init) => {
    assert(init?.signal);
    return pendingResponse(init.signal);
  });
  await assert.rejects(
    client.request("/api/generate", {}, controller.signal),
    (error) => error instanceof AppError && error.code === "AI_TIMEOUT",
  );
  assert.equal(controller.signal.aborted, false);
});

test("cancelling generation frees the analysis slot and skips an already cancelled queued analysis", async () => {
  const started = deferred<void>();
  let generated = 0;
  let rendered = 0;
  const provider = new OllamaSelectorAnalysisProvider(config, {
    renderPage: async () => {
      rendered++;
      return page;
    },
    client: new OllamaClient(config, async (_url, init) => {
      generated++;
      if (generated !== 1) return generatedResponse();
      assert(init?.signal);
      started.resolve();
      return pendingResponse(init.signal);
    }),
  });
  const first = new AbortController();
  const firstResult = provider.analyze(input, first.signal);
  await started.promise;
  const queued = new AbortController();
  const queuedResult = provider.analyze(input, queued.signal);
  const queuedFailure = assert.rejects(queuedResult, (error) => error === queued.signal.reason);
  queued.abort();
  first.abort();
  await assert.rejects(firstResult, (error) => error === first.signal.reason);
  await queuedFailure;
  const retried = await provider.analyze(input);
  assert.equal(retried.kind, "SCRAPING");
  assert(retried.kind === "SCRAPING");
  assert.deepEqual(retried.scrapingConfig, scrapingConfig);
  assert.equal(generated, 2);
  assert.equal(rendered, 2);
});

test("cancelling while loading a public page prevents a later model request", async () => {
  const started = deferred<void>();
  const loaded = deferred<PublicSelectorPage>();
  let generated = 0;
  const provider = new OllamaSelectorAnalysisProvider(config, {
    renderPage: async () => {
      started.resolve();
      return loaded.promise;
    },
    client: new OllamaClient(config, async () => {
      generated++;
      return generatedResponse();
    }),
  });
  const controller = new AbortController();
  const pending = provider.analyze(input, controller.signal);
  await started.promise;
  controller.abort();
  loaded.resolve(page);
  await assert.rejects(pending, (error) => error === controller.signal.reason);
  assert.equal(generated, 0);
});

async function application(provider: SelectorAnalysisProvider) {
  let tickets = 0;
  let emails = 0;
  let errors = 0;
  let responses = 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { userId: "selector-cancellation-user" } as typeof req.session;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responses++;
      return originalJson(body);
    };
    next();
  });
  app.use(
    "/ai/selectors",
    selectorAssistanceRouter({} as Db, provider, {
      async create() {
        tickets++;
        return "a9868f31-2cd5-47e5-8290-86eb544ba907";
      },
      async send() {
        emails++;
        return { message: "Unexpected email" };
      },
    } as unknown as SelectorHelpService),
  );
  app.use(((error: Error, _req, res, _next) => {
    errors++;
    res.status(500).json({ message: error.message });
  }) as express.ErrorRequestHandler);
  const listening = deferred<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  await listening.promise;
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/ai/selectors/analyze`,
    counts: () => ({ tickets, emails, errors, responses }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function analyze(url: string, signal?: AbortSignal) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

test("a normally consumed request body and completed response do not cancel analysis", async () => {
  const started = deferred<AbortSignal>();
  const complete = deferred<SelectorAnalysisResult>();
  const app = await application({
    async analyze(_input, signal) {
      assert(signal);
      started.resolve(signal);
      return complete.promise;
    },
  });
  try {
    const pending = analyze(app.url);
    const signal = await started.promise;
    assert.equal(signal.aborted, false);
    complete.resolve(result);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, false);
    assert.deepEqual(app.counts(), { tickets: 0, emails: 0, errors: 0, responses: 1 });
  } finally {
    await app.close();
  }
});

test("disconnecting the analysis response aborts the provider without help tickets, emails or error responses", async () => {
  const started = deferred<AbortSignal>();
  const stopped = deferred<void>();
  const app = await application({
    async analyze(_input, signal) {
      assert(signal);
      started.resolve(signal);
      try {
        await pendingResponse(signal);
        return result;
      } finally {
        stopped.resolve();
      }
    },
  });
  try {
    const controller = new AbortController();
    const pending = analyze(app.url, controller.signal);
    const signal = await started.promise;
    controller.abort();
    await assert.rejects(pending);
    await stopped.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(signal.aborted);
    assert.deepEqual(app.counts(), { tickets: 0, emails: 0, errors: 0, responses: 0 });
  } finally {
    await app.close();
  }
});

test("a provider finishing after disconnection cannot create a partial-result help ticket", async () => {
  const started = deferred<void>();
  const disconnected = deferred<void>();
  const complete = deferred<SelectorAnalysisResult>();
  const app = await application({
    async analyze(_input, signal) {
      assert(signal);
      signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
      started.resolve();
      return complete.promise;
    },
  });
  try {
    const controller = new AbortController();
    const pending = analyze(app.url, controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(pending);
    await disconnected.promise;
    complete.resolve({ ...result, complete: false, missingFields: ["linkSelector"] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(app.counts(), { tickets: 0, emails: 0, errors: 0, responses: 0 });
  } finally {
    await app.close();
  }
});
