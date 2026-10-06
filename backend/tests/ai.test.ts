import { test, expect } from "bun:test";
import { OllamaClient, OllamaSummaryProvider, summaryPrompt, summarySchema, summaryInputSchema } from "../src/ai";
import { readConfig } from "../src/config";
const config = readConfig({ DATABASE_URL: "postgresql://localhost/test", SESSION_SECRET: "x".repeat(32) });
const input = { title: "Article", content: "<p> Information    utile </p>" };
const output = { title: "Titre", summary: "Résumé fidèle.", keyPoints: ["Information utile"] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
test("prompts normalize HTML, limit input and specify French faithful JSON", () => {
  const prompt = summaryPrompt(input, "français", 200); expect(prompt).toContain("français"); expect(prompt).toContain("Information utile"); expect(prompt).not.toContain("<p>");
  expect(summaryPrompt({ title: "Titre", content: "a".repeat(1000) }, "français", 100)).not.toContain("a".repeat(101));
  expect(() => summaryPrompt({ title: "Titre", content: "<p> </p>" }, "français", 100)).toThrow("vide");
});
test("validates input and output shapes", () => {
  expect(summarySchema.safeParse(output).success).toBe(true);
  expect(summarySchema.safeParse({ ...output, keyPoints: [1] }).success).toBe(false);
  expect(summaryInputSchema.safeParse({ title: "", content: "" }).success).toBe(false);
});
test("returns validated summaries from the configured model", async () => {
  let requestBody = "";
  const provider = new OllamaSummaryProvider(config, new OllamaClient(config, async (_url, init) => { requestBody = String(init?.body); return response({ response: JSON.stringify(output) }); }));
  expect(await provider.summarize(input)).toEqual(output); expect(JSON.parse(requestBody).model).toBe(config.OLLAMA_MODEL);
});
test("rejects empty, malformed and invalid structured AI responses", async () => {
  for (const value of [{ response: "" }, { response: "not json" }, { response: JSON.stringify({ summary: "no title" }) }, {}]) {
    const provider = new OllamaSummaryProvider(config, new OllamaClient(config, async () => response(value)));
    await expect(provider.summarize(input)).rejects.toThrow();
  }
});
test("distinguishes missing model, unavailable service and timeouts", async () => {
  await expect(new OllamaSummaryProvider(config, new OllamaClient(config, async () => response({}, 404))).summarize(input)).rejects.toThrow("pas installé");
  await expect(new OllamaSummaryProvider(config, new OllamaClient(config, async () => { throw new Error("offline"); })).summarize(input)).rejects.toThrow("indisponible");
  await expect(new OllamaSummaryProvider(config, new OllamaClient(config, async () => { throw new DOMException("timeout", "TimeoutError"); })).summarize(input)).rejects.toThrow("délai");
});
test("health identifies availability and missing models", async () => {
  expect(await new OllamaClient(config, async () => response({ models: [{ name: config.OLLAMA_MODEL }] })).health()).toBe("ok");
  expect(await new OllamaClient(config, async () => response({ models: [] })).health()).toBe("model_missing");
  expect(await new OllamaClient(config, async () => { throw new Error(); }).health()).toBe("unavailable");
});
test("generation concurrency stays bounded", async () => {
  let active = 0; let max = 0;
  const client = new OllamaClient(config, async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return response({ response: JSON.stringify(output) }); });
  const provider = new OllamaSummaryProvider(config, client); await Promise.all([provider.summarize(input), provider.summarize(input), provider.summarize(input)]); expect(max).toBe(1);
});
