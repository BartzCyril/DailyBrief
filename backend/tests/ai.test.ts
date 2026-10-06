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
test("prompts normalize HTML, limit input and specify French faithful JSON", () => {
  const prompt = summaryPrompt(input, "français", 200);
  expect(prompt).toContain("français");
  expect(prompt).toContain("Information utile");
  expect(prompt).not.toContain("<p>");
  expect(
    summaryPrompt({ title: "Titre", content: "a".repeat(1000) }, "français", 100),
  ).not.toContain("a".repeat(101));
  expect(() => summaryPrompt({ title: "Titre", content: "<p> </p>" }, "français", 100)).toThrow(
    "vide",
  );
});
test("validates input and output shapes", () => {
  expect(summarySchema.safeParse(output).success).toBe(true);
  expect(summarySchema.safeParse({ ...output, keyPoints: [1] }).success).toBe(false);
  expect(summaryInputSchema.safeParse({ title: "", content: "" }).success).toBe(false);
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
