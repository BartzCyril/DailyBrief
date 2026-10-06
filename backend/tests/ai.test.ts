import { test, expect } from "bun:test";
import {
  OllamaClient,
  OllamaSummaryProvider,
  summaryPrompt,
  summarySchema,
  summaryInputSchema,
} from "../src/ai";
import { readConfig } from "../src/config";
const config = readConfig({
  DATABASE_URL: "postgresql://localhost/test",
  SESSION_SECRET: "x".repeat(32),
});
const input = { title: "Article", content: "<p> Information    utile </p>" };
const output = { title: "Titre", summary: "Résumé fidèle.", keyPoints: ["Information utile"] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
test("prompts normalize HTML, refuse silent truncation and specify French faithful JSON", () => {
  const prompt = summaryPrompt(input, "français", 200);
  expect(prompt).toContain("français");
  expect(prompt).toContain("Information utile");
  expect(prompt).not.toContain("<p>");
  expect(() =>
    summaryPrompt({ title: "Titre", content: "a".repeat(1000) }, "français", 100),
  ).toThrow("découpé");
  expect(() => summaryPrompt({ title: "Titre", content: "<p> </p>" }, "français", 100)).toThrow(
    "vide",
  );
});
test("long articles send every portion including the end, then synthesize their summaries", async () => {
  const smallConfig = { ...config, AI_MAX_INPUT_CHARS: 1000 };
  const prompts: string[] = [];
  const progress: string[] = [];
  const provider = new OllamaSummaryProvider(
    smallConfig,
    new OllamaClient(smallConfig, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).prompt;
      prompts.push(prompt);
      return response({
        response: JSON.stringify({
          title: "Article",
          summary: prompt.includes("INFORMATION_FINALE")
            ? "Mesure finale incluse."
            : "Autres mesures.",
          keyPoints: ["Point"],
        }),
      });
    }),
  );
  const content = "Détail du texte. ".repeat(180) + "INFORMATION_FINALE";
  const result = await provider.summarize({ title: "Article", content }, (message) =>
    progress.push(message),
  );
  const chunkPrompts = prompts.filter((prompt) => !prompt.includes("Partie 1 :"));
  expect(chunkPrompts.length).toBeGreaterThan(1);
  expect(chunkPrompts.at(-1)).toContain("INFORMATION_FINALE");
  const inputs = chunkPrompts.map((prompt) => JSON.parse(prompt.split("ARTICLE:\n")[1]!).content);
  expect(inputs.join(" ")).toBe(content);
  expect(prompts.at(-1)).toContain("Mesure finale incluse.");
  expect(progress.some((message) => message.includes("Synthèse"))).toBe(true);
  expect(result.title).toBe("Article");
});
test("default settings keep a 10k article in one request and preserve explicit env overrides", async () => {
  const prompts: string[] = [];
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      prompts.push(JSON.parse(body.prompt.split("ARTICLE:\n")[1]!).content);
      return response({ response: JSON.stringify(output), done: true });
    }),
  );
  const content = "Une mesure budgétaire détaillée. ".repeat(320) + "DERNIERE_MESURE";
  await provider.summarize({ title: "Budget", content });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toBe(content);
  expect(prompts[0]).toContain("DERNIERE_MESURE");
  expect(prompts.every((prompt) => prompt.length <= config.AI_MAX_INPUT_CHARS)).toBe(true);
  expect(config.OLLAMA_TIMEOUT_MS).toBe(1800000);
  expect(
    readConfig({
      DATABASE_URL: "postgresql://localhost/test",
      SESSION_SECRET: "x".repeat(32),
      OLLAMA_TIMEOUT_MS: "900000",
      AI_MAX_INPUT_CHARS: "4000",
    }),
  ).toMatchObject({ OLLAMA_TIMEOUT_MS: 900000, AI_MAX_INPUT_CHARS: 4000 });
});
test("the real generation deadline cancels a pending request and gives actionable timeout details", async () => {
  const shortConfig = { ...config, OLLAMA_TIMEOUT_MS: 25 };
  let cancelled = false;
  const provider = new OllamaSummaryProvider(
    shortConfig,
    new OllamaClient(shortConfig, async (_url, init) => {
      expect(init?.timeout).toBe(false);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    }),
  );
  await expect(provider.summarize(input)).rejects.toMatchObject({
    code: "AI_TIMEOUT",
    message: expect.stringContaining("OLLAMA_TIMEOUT_MS"),
  });
  expect(cancelled).toBe(true);
});
test("progress remains visible while Ollama is pending and stops after a validated result", async () => {
  const progress: string[] = [];
  let complete = (_value: Response) => {};
  const waiting = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const provider = new OllamaSummaryProvider(config, new OllamaClient(config, async () => waiting));
  const result = provider.summarize(input, (message) => progress.push(message));
  await new Promise((resolve) => setTimeout(resolve, 15200));
  expect(
    progress.some((message) => message.includes("En attente") && message.includes("portion 1/1")),
  ).toBe(true);
  complete(response({ response: JSON.stringify(output), done: true }));
  expect(await result).toEqual(output);
  expect(progress.at(-1)).toContain("terminé");
}, 20000);
test("failed portions prevent a partial summary from being returned", async () => {
  const smallConfig = { ...config, AI_MAX_INPUT_CHARS: 1000 };
  let calls = 0;
  const provider = new OllamaSummaryProvider(
    smallConfig,
    new OllamaClient(smallConfig, async () => {
      calls++;
      return calls === 1 ? response({ response: JSON.stringify(output) }) : response({}, 503);
    }),
  );
  await expect(
    provider.summarize({ title: "Article", content: "texte ".repeat(400) }),
  ).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
  expect(calls).toBe(2);
});
test("validates input and output shapes", () => {
  expect(summarySchema.safeParse(output).success).toBe(true);
  expect(summarySchema.safeParse({ ...output, keyPoints: [1] }).success).toBe(false);
  expect(summaryInputSchema.safeParse({ title: "", content: "" }).success).toBe(false);
});
test("accepts longer summaries without clipping them and rejects an oversized response", async () => {
  const longOutput = { ...output, summary: "Résumé détaillé. ".repeat(500).trim() };
  let requestedSummaryLimit: number | undefined;
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      requestedSummaryLimit = JSON.parse(String(init?.body)).format.properties.summary.maxLength;
      return response({ response: JSON.stringify(longOutput), done: true });
    }),
  );
  expect((await provider.summarize(input)).summary).toBe(longOutput.summary);
  expect(requestedSummaryLimit).toBe(12000);
  expect(summarySchema.safeParse({ ...output, summary: "a".repeat(12001) }).success).toBe(false);
});
test("returns validated summaries from the configured model", async () => {
  let requestBody = "";
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      requestBody = String(init?.body);
      return response({ response: JSON.stringify(output) });
    }),
  );
  expect(await provider.summarize(input)).toEqual(output);
  expect(JSON.parse(requestBody).model).toBe(config.OLLAMA_MODEL);
  expect(JSON.parse(requestBody)).toMatchObject({ think: false, stream: false });
  expect(JSON.parse(requestBody).format.required).toEqual(["title", "summary", "keyPoints"]);
});
test("Qwen3 receives think:false and returns its final answer rather than a thinking-only response", async () => {
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return request.think === false
        ? response({
            response: JSON.stringify(output),
            thinking: "",
            done: true,
            done_reason: "stop",
          })
        : response({
            response: "",
            thinking: "Internal reasoning",
            done: true,
            done_reason: "stop",
          });
    }),
  );
  expect(await provider.summarize(input)).toEqual(output);
});
test("distinguishes empty, thinking-only, incomplete and malformed Ollama responses", async () => {
  const cases = [
    { data: { response: " \n ", done: true }, code: "EMPTY_AI_RESPONSE", message: "réponse vide" },
    {
      data: { response: "", thinking: "Private reasoning", done: true },
      code: "EMPTY_AI_RESPONSE",
      message: "raisonnement sans résumé final",
    },
    {
      data: { response: "", thinking: "Reasoning", done: true, done_reason: "length" },
      code: "INCOMPLETE_AI_RESPONSE",
      message: "interrompu",
    },
    {
      data: { response: JSON.stringify(output), done: false },
      code: "INCOMPLETE_AI_RESPONSE",
      message: "interrompu",
    },
    {
      data: { response: JSON.stringify(output), done: true, done_reason: "length" },
      code: "INCOMPLETE_AI_RESPONSE",
      message: "interrompu",
    },
    {
      data: { message: { content: JSON.stringify(output) } },
      code: "INVALID_AI_RESPONSE",
      message: "Format de réponse Ollama invalide",
    },
  ];
  for (const { data, code, message } of cases) {
    const provider = new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => response(data)),
    );
    await expect(provider.summarize(input)).rejects.toMatchObject({
      code,
      message: expect.stringContaining(message),
    });
  }
});
test("rejects empty, malformed and invalid structured AI responses", async () => {
  for (const value of [
    { response: "" },
    { response: "not json" },
    { response: JSON.stringify({ summary: "no title" }) },
    {},
  ]) {
    const provider = new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => response(value)),
    );
    await expect(provider.summarize(input)).rejects.toThrow();
  }
});
test("distinguishes missing model, unavailable service and timeouts", async () => {
  await expect(
    new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => response({}, 404)),
    ).summarize(input),
  ).rejects.toThrow("pas installé");
  await expect(
    new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => {
        throw new Error("offline");
      }),
    ).summarize(input),
  ).rejects.toThrow("indisponible");
  await expect(
    new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => {
        throw new DOMException("timeout", "TimeoutError");
      }),
    ).summarize(input),
  ).rejects.toThrow("délai");
});
test("health identifies availability and missing models", async () => {
  expect(
    await new OllamaClient(config, async () =>
      response({ models: [{ name: config.OLLAMA_MODEL }] }),
    ).health(),
  ).toBe("ok");
  expect(await new OllamaClient(config, async () => response({ models: [] })).health()).toBe(
    "model_missing",
  );
  expect(
    await new OllamaClient(config, async () => {
      throw new Error();
    }).health(),
  ).toBe("unavailable");
});
test("generation concurrency stays bounded", async () => {
  let active = 0;
  let max = 0;
  const client = new OllamaClient(config, async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return response({ response: JSON.stringify(output) });
  });
  const provider = new OllamaSummaryProvider(config, client);
  await Promise.all([
    provider.summarize(input),
    provider.summarize(input),
    provider.summarize(input),
  ]);
  expect(max).toBe(1);
});
