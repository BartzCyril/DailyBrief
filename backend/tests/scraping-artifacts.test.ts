import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseScraping } from "../scripts/diagnose-scraping";
import { ScrapingService } from "../src/scraping";
import type { ScrapingPageDiagnostic } from "../src/scraping-diagnostics";

const config = {
  articleSelector: ".teaser",
  titleSelector: ".teaser__title",
  linkSelector: ".teaser__link",
  dateSelector: ".meta__date",
  mode: "SCROLL" as const,
  scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
};
const html =
  '<main><article class="news-card"><h2 class="teaser__title">Titre public</h2><a class="teaser__link" href="/article">Lire</a><time class="meta__date">12 octobre 2026</time><input type="password" value="never-export-value"></article></main>';

test("counts global title and link matches even when the configured article container is missing", async () => {
  let observed: ScrapingPageDiagnostic | undefined;
  const service = new ScrapingService(async () => html);
  await expect(
    service.validateFirstPage("https://fixture.example/", config, (diagnostic) => {
      observed = diagnostic;
    }),
  ).rejects.toMatchObject({ code: "EMPTY_SCRAPING" });
  expect(observed).toMatchObject({
    articleBlocks: 0,
    withTitle: 0,
    withLink: 0,
    pageTitleMatches: 1,
    pageLinkMatches: 1,
    pageDateMatches: 1,
  });
}, 15000);

test("keeps a screenshot and structural ancestors on empty extraction without saving HTML, text or URL secrets", async () => {
  const output = await mkdtemp(join(tmpdir(), "dailybrief-scraping-artifacts-"));
  try {
    const service = new ScrapingService(async () => html);
    await expect(
      diagnoseScraping(
        [
          "https://fixture.example/patrimoine/?token=never-export-query",
          ".teaser",
          ".teaser__title",
          ".teaser__link",
          ".meta__date",
        ],
        service,
        output,
      ),
    ).rejects.toMatchObject({ code: "EMPTY_SCRAPING" });
    const source = await readFile(join(output, "scraping-structure.json"), "utf8");
    const structure = JSON.parse(source);
    expect(structure.loadedPage).toBe("https://fixture.example/patrimoine/");
    expect(structure.candidateAncestors[0]).toContain("article.news-card");
    expect(structure.totalLinks).toBe(1);
    for (const secret of ["never-export-value", "never-export-query", "Titre public", "<main>"])
      expect(source).not.toContain(secret);
    const png = await readFile(join(output, "scraping-page.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 30000);
