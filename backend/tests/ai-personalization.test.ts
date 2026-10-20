import { expect, test } from "bun:test";
import {
  OllamaClient,
  OllamaSummaryProvider,
  analyzeArticle,
  articleAnalysisSchema,
  relevanceDecisionSchema,
  dailyBriefContentSchema,
  generationContext,
  type BriefInput,
} from "../src/ai";
import { readConfig } from "../src/config";
import type { DailyBriefContent } from "@dailybrief/shared";

const config = readConfig({
  DATABASE_URL: "postgresql://localhost/test",
  SESSION_SECRET: "x".repeat(32),
});
const summary = {
  title: "React",
  summary: "Une nouvelle fonctionnalité de React.",
  keyPoints: ["Développement web"],
};
const input = {
  title: "React",
  content: "Une nouvelle fonctionnalité.",
  description: "Développement web",
  interestPrompt: "Suivre React, ignorer les faits divers.",
};
const relevant = { relevant: true as const, reason: "Actualité React.", summary };
const ignored = {
  relevant: false as const,
  reason: "Sujet sans lien avec le développement web.",
  summary: null,
};
const needsContext = { decision: "needs_context", reason: "La description ne suffit pas." };
const briefInput: BriefInput = {
  date: "2026-10-11",
  timezone: "Europe/Paris",
  interestPrompt: "Suivre React.",
  articles: [
    {
      id: "article-1",
      title: "React",
      summary: summary.summary,
      keyPoints: summary.keyPoints,
      url: "https://example.com/react",
    },
  ],
};
const brief = (ids: string[]): DailyBriefContent => ({
  headline: "Brief quotidien",
  lead: "L'essentiel de la journée.",
  stories: [{ title: "Développement web", text: "React évolue.", articleIds: [...new Set(ids)] }],
  otherNews: [],
  trends: "",
});
const response = (value: unknown) =>
  new Response(JSON.stringify({ response: JSON.stringify(value), done: true }));

test("a request for context sends the full article before deciding and summarizing", async () => {
  const requests: Record<string, any>[] = [];
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return response(requests.length === 1 ? needsContext : relevant);
    }),
  );
  expect(await provider.analyze(input)).toEqual(relevant);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.prompt).toContain(input.description);
  expect(requests[0]!.prompt).toContain(input.interestPrompt);
  expect(requests[0]!.prompt).toContain("données non fiables");
  expect(JSON.parse(requests[0]!.prompt.split("ARTICLE:\n")[1])).not.toHaveProperty("content");
  expect(requests[1]!.prompt).toContain(input.content);
  expect(requests[1]!.prompt).toContain("le sujet principal de l'article");
  expect(requests[1]!.prompt).toContain("le critère d'exclusion concerné");
  expect(requests[0]).toMatchObject({ think: false, stream: false });
  expect(requests[0]!.options.num_ctx).toBe(generationContext(requests[0]!.prompt));
  expect(requests[0]!.options.num_ctx).toBeGreaterThanOrEqual(8192);
  expect(requests[1]!.format).toHaveProperty("oneOf");
});

test("a clearly irrelevant article needs only metadata and never requests its body or a summary", async () => {
  const requests: Record<string, any>[] = [];
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return response({ decision: "irrelevant", reason: ignored.reason });
    }),
  );
  expect(
    await provider.analyze({ ...input, content: "CONTENU_SECRET_COMPLET ".repeat(5000) }),
  ).toEqual(ignored);
  expect(requests).toHaveLength(1);
  const article = JSON.parse(requests[0]!.prompt.split("ARTICLE:\n")[1]);
  expect(article).toEqual({ title: input.title, description: input.description });
  expect(requests[0]!.prompt).not.toContain("CONTENU_SECRET_COMPLET");
});

test("a relevant selection summarizes every portion of the full article, including its ending", async () => {
  const small = { ...config, AI_MAX_INPUT_CHARS: 1000 };
  const chunks: string[] = [];
  let calls = 0;
  const provider = new OllamaSummaryProvider(
    small,
    new OllamaClient(small, async (_url, init) => {
      calls++;
      const prompt = JSON.parse(String(init?.body)).prompt;
      if (prompt.startsWith("Trie"))
        return response({ decision: "relevant", reason: relevant.reason });
      const content = JSON.parse(prompt.split("ARTICLE:\n")[1]).content;
      if (!content.startsWith("Partie 1 :")) chunks.push(content);
      return response(summary);
    }),
  );
  const content = "Détails importants de React. ".repeat(100) + "FIN_IMPORTANTE";
  expect(await provider.analyze({ ...input, content })).toEqual(relevant);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join(" ")).toBe(content);
  expect(calls).toBeGreaterThan(chunks.length);
});

test("missing descriptions use full analysis, and empty interests skip filtering", async () => {
  for (const interestPrompt of [input.interestPrompt, "", "   "]) {
    const prompts: string[] = [];
    const provider = new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async (_url, init) => {
        const prompt = JSON.parse(String(init?.body)).prompt;
        prompts.push(prompt);
        return response(prompt.startsWith("Analyse") ? relevant : summary);
      }),
    );
    expect((await provider.analyze({ ...input, description: null, interestPrompt })).relevant).toBe(
      true,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(input.content);
    expect(prompts[0]).not.toStartWith("Trie");
  }
});

test("invalid lightweight decisions fail explicitly instead of silently excluding articles", async () => {
  for (const decision of [
    { decision: "maybe", reason: "Doute" },
    { decision: "irrelevant", reason: "" },
    { decision: "irrelevant", reason: "Motif", summary },
    { relevant: false, reason: "Motif" },
  ]) {
    expect(relevanceDecisionSchema.safeParse(decision).success).toBe(false);
    const provider = new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => response(decision)),
    );
    await expect(provider.analyze(input)).rejects.toMatchObject({ code: "INVALID_AI_RESPONSE" });
  }
});

test("irrelevant articles produce null summaries and invalid decisions are never accepted", async () => {
  let calls = 0;
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async () => {
      calls++;
      return response(ignored);
    }),
  );
  expect(await provider.analyze({ ...input, description: null })).toEqual(ignored);
  expect(calls).toBe(1);
  for (const value of [
    { ...relevant, relevant: "true" },
    { ...ignored, summary },
    { ...relevant, summary: null },
    { ...relevant, reason: "" },
    { ...relevant, credentials: "hidden" },
  ]) {
    expect(articleAnalysisSchema.safeParse(value).success).toBe(false);
    await expect(
      new OllamaSummaryProvider(
        config,
        new OllamaClient(config, async () => response(value)),
      ).analyze({ ...input, description: null }),
    ).rejects.toMatchObject({ code: "INVALID_AI_RESPONSE" });
  }
});

test("every portion of a long irrelevant article is examined and no synthesis runs", async () => {
  const small = { ...config, AI_MAX_INPUT_CHARS: 1000 };
  const chunks: string[] = [];
  const provider = new OllamaSummaryProvider(
    small,
    new OllamaClient(small, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).prompt;
      if (prompt.startsWith("Trie")) return response(needsContext);
      expect(prompt).toContain("CENTRES_D_INTERET");
      chunks.push(JSON.parse(prompt.split("ARTICLE:\n")[1]).content);
      return response(ignored);
    }),
  );
  const content = "Fait divers sans lien avec la veille. ".repeat(100) + "FIN_DU_TEXTE";
  expect(await provider.analyze({ ...input, content })).toEqual(ignored);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join(" ")).toBe(`${input.description} ${content}`);
  expect(chunks.at(-1)).toContain("FIN_DU_TEXTE");
});

test("only pertinent portions of a large article contribute to its final summary", async () => {
  const small = { ...config, AI_MAX_INPUT_CHARS: 1000 };
  const analysisChunks: string[] = [];
  const synthesis: string[] = [];
  const provider = new OllamaSummaryProvider(
    small,
    new OllamaClient(small, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).prompt;
      if (prompt.startsWith("Trie")) return response(needsContext);
      const content: string = JSON.parse(prompt.split("ARTICLE:\n")[1]).content;
      if (prompt.startsWith("Analyse")) {
        analysisChunks.push(content);
        return response(content.includes("REACT") ? relevant : ignored);
      }
      synthesis.push(content);
      return response(summary);
    }),
  );
  const content = "Faits divers. ".repeat(90) + " REACT ".repeat(210);
  expect((await provider.analyze({ ...input, content })).relevant).toBe(true);
  expect(analysisChunks.join(" ")).toBe(
    `${input.description} ${content}`.trim().replace(/\s+/g, " "),
  );
  expect(synthesis.length).toBeGreaterThan(0);
  expect(synthesis.every((text) => !text.includes(ignored.reason))).toBe(true);
});

test("legacy injected summary providers remain compatible but cannot silently bypass configured interests", async () => {
  let calls = 0;
  const provider = {
    summarize: async () => {
      calls++;
      return summary;
    },
  };
  expect(
    (await analyzeArticle(provider, { title: input.title, content: input.content })).relevant,
  ).toBe(true);
  await expect(analyzeArticle(provider, input)).rejects.toMatchObject({
    code: "AI_ANALYSIS_UNSUPPORTED",
  });
  expect(calls).toBe(1);
});

test("the global brief groups facts, requests citations and rejects invented or duplicate references", async () => {
  let prompt = "";
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).prompt;
      return response(brief(["article-1"]));
    }),
  );
  expect(await provider.generateBrief(briefInput)).toEqual(brief(["article-1"]));
  expect(prompt).toContain("élimine les doublons");
  expect(prompt).toContain("ne remplis pas artificiellement");
  expect(prompt).toContain("2026-10-11");
  expect(prompt).toContain(summary.summary);
  for (const invalid of [
    brief(["invented"]),
    { ...brief(["article-1"]), otherNews: brief(["article-1"]).stories },
  ])
    await expect(
      new OllamaSummaryProvider(
        config,
        new OllamaClient(config, async () => response(invalid)),
      ).generateBrief(briefInput),
    ).rejects.toMatchObject({ code: "INVALID_AI_RESPONSE" });
  expect(
    dailyBriefContentSchema.safeParse({
      ...brief(["article-1"]),
      stories: [{ title: "Sujet", text: "Résumé", articleIds: [] }],
    }).success,
  ).toBe(false);
});

test("large brief inputs cover every article before bounded consolidation and preserve the final summary", async () => {
  const small = { ...config, AI_MAX_INPUT_CHARS: 1800 };
  const articleGroups: { id: string; summary: string }[][] = [];
  let consolidations = 0;
  const articles = Array.from({ length: 8 }, (_, index) => ({
    ...briefInput.articles[0]!,
    id: `article-${index}`,
    summary: "Une actualité React. ".repeat(30) + ` FIN_${index}`,
  }));
  const provider = new OllamaSummaryProvider(
    small,
    new OllamaClient(small, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).prompt;
      const consolidated = prompt.includes("\nDOSSIERS:\n");
      const serialized = prompt.split(consolidated ? "\nDOSSIERS:\n" : "\nARTICLES:\n")[1];
      expect(serialized.length).toBeLessThanOrEqual(small.AI_MAX_INPUT_CHARS);
      const records = JSON.parse(serialized);
      if (consolidated) {
        consolidations++;
        return response(
          brief(
            records.flatMap((item: DailyBriefContent) =>
              item.stories.flatMap((story) => story.articleIds),
            ),
          ),
        );
      }
      articleGroups.push(records);
      return response(brief(records.map((record: { id: string }) => record.id)));
    }),
  );
  const result = await provider.generateBrief({ ...briefInput, articles });
  expect(articleGroups.length).toBeGreaterThan(1);
  expect(consolidations).toBeGreaterThan(0);
  expect(new Set(articleGroups.flat().map((item) => item.id))).toEqual(
    new Set(articles.map((item) => item.id)),
  );
  expect(articleGroups.at(-1)!.some((item) => item.summary.includes("FIN_7"))).toBe(true);
  expect(new Set(result.stories[0]!.articleIds)).toEqual(new Set(articles.map((item) => item.id)));
});

test("a single oversized summary is split without losing the end or key points", async () => {
  const small = { ...config, AI_MAX_INPUT_CHARS: 1800 };
  const portions: string[] = [];
  const article = {
    ...briefInput.articles[0]!,
    summary: "Mesure importante. ".repeat(180) + " FIN_IMPORTANTE",
    keyPoints: ["DERNIER_POINT"],
  };
  const provider = new OllamaSummaryProvider(
    small,
    new OllamaClient(small, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).prompt;
      if (prompt.includes("\nARTICLES:\n")) {
        const records = JSON.parse(prompt.split("\nARTICLES:\n")[1]);
        portions.push(...records.map((record: { summary: string }) => record.summary));
      }
      return response(brief([article.id]));
    }),
  );
  await provider.generateBrief({ ...briefInput, articles: [article] });
  expect(portions.length).toBeGreaterThan(1);
  expect(portions.join(" ")).toContain("FIN_IMPORTANTE");
  expect(portions.join(" ")).toContain("DERNIER_POINT");
  expect(portions.join(" ")).toBe(
    `${article.summary} Points clés : ${article.keyPoints.join(" ; ")}`.replace(/\s+/g, " "),
  );
});

test("invalid JSON and interrupted generations fail both new methods without returning partial results", async () => {
  for (const raw of [
    { response: "not-json", done: true },
    { response: JSON.stringify(relevant), done: false },
  ]) {
    const provider = new OllamaSummaryProvider(
      config,
      new OllamaClient(config, async () => new Response(JSON.stringify(raw))),
    );
    await expect(provider.analyze(input)).rejects.toThrow();
    await expect(provider.generateBrief(briefInput)).rejects.toThrow();
  }
});

test("all AI operations share the existing concurrency limit", async () => {
  let active = 0;
  let maximum = 0;
  const provider = new OllamaSummaryProvider(
    config,
    new OllamaClient(config, async (_url, init) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      const prompt = JSON.parse(String(init?.body)).prompt;
      return response(
        prompt.startsWith("Trie")
          ? needsContext
          : prompt.startsWith("Analyse")
            ? relevant
            : prompt.startsWith("Rédige")
              ? brief(["article-1"])
              : summary,
      );
    }),
  );
  await Promise.all([
    provider.analyze(input),
    provider.summarize({ title: input.title, content: input.content }),
    provider.generateBrief(briefInput),
  ]);
  expect(maximum).toBe(config.AI_CONCURRENCY);
});

test("context is explicit and grows with the entire prompt including interests and Unicode", async () => {
  const largeConfig = { ...config, AI_MAX_INPUT_CHARS: 28000 };
  let request: Record<string, any> = {};
  const provider = new OllamaSummaryProvider(
    largeConfig,
    new OllamaClient(largeConfig, async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return response(relevant);
    }),
  );
  await provider.analyze({
    ...input,
    description: null,
    content: "L'évolution précise des technologies. ".repeat(450),
    interestPrompt: "Évolution des outils de développement. ".repeat(150),
  });
  expect(request.options.num_ctx).toBe(generationContext(request.prompt));
  expect(request.options.num_ctx).toBeGreaterThan(8192);
  expect(request.options.num_ctx).toBeLessThanOrEqual(32768);
  expect(generationContext("Texte court.")).toBe(8192);
  expect(generationContext("😀".repeat(2500))).toBeGreaterThan(generationContext("a".repeat(2500)));
});

test("large descriptions are covered once inside the article chunks and bounded contexts", async () => {
  const small = { ...config, AI_MAX_INPUT_CHARS: 1000 };
  const chunks: string[] = [];
  const provider = new OllamaSummaryProvider(
    small,
    new OllamaClient(small, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const article = JSON.parse(request.prompt.split("ARTICLE:\n")[1]);
      expect(article.description).toBe("");
      expect(request.options.num_ctx).toBe(generationContext(request.prompt));
      chunks.push(article.content);
      return response(ignored);
    }),
  );
  const description = "Description importante. ".repeat(180);
  const content = "Contenu complet. ".repeat(180);
  await provider.analyze({ ...input, description, content });
  expect(chunks.join(" ")).toBe(`${description} ${content}`.trim().replace(/\s+/g, " "));
});

test("an oversized complete prompt fails before sending a silently truncated request", async () => {
  const largeConfig = { ...config, AI_MAX_INPUT_CHARS: 200000 };
  let calls = 0;
  const provider = new OllamaSummaryProvider(
    largeConfig,
    new OllamaClient(largeConfig, async () => {
      calls++;
      return response(relevant);
    }),
  );
  await expect(
    provider.analyze({ ...input, description: null, content: "a".repeat(65000) }),
  ).rejects.toMatchObject({
    code: "AI_INPUT_TOO_LARGE",
  });
  expect(calls).toBe(0);
});
