import { ScrapingService } from "../src/scraping";
import { AppError } from "../src/errors";
import type { ScrapingConfig } from "@dailybrief/shared";
import type { Page } from "puppeteer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultOutput = fileURLToPath(new URL("../../diagnostics/", import.meta.url));

export async function writeScrapingArtifacts(
  page: Page,
  config: ScrapingConfig,
  output = defaultOutput,
) {
  await mkdir(output, { recursive: true });
  const screenshotPath = resolve(output, "scraping-page.png");
  const structurePath = resolve(output, "scraping-structure.json");
  const structure = await page.evaluate((config) => {
    const describe = (element: Element) =>
      element.tagName.toLowerCase() +
      [...element.classList]
        .filter((name) => /^[a-zA-Z_-][a-zA-Z0-9_-]{0,60}$/.test(name))
        .slice(0, 4)
        .map((name) => `.${name}`)
        .join("");
    const titles = [...document.querySelectorAll(config.titleSelector)];
    const headings = titles.length
      ? titles
      : [...document.querySelectorAll("main h2, main h3, main h4, h1")];
    return {
      // No query strings, fragments, text, HTML, input values or cookies are saved.
      loadedPage: location.origin + location.pathname,
      readyState: document.readyState,
      totalLinks: document.querySelectorAll("a[href]").length,
      totalHeadings: document.querySelectorAll("h1, h2, h3, h4").length,
      candidateAncestors: headings.slice(0, 12).map((heading) => {
        const lineage = [];
        let element: Element | null = heading;
        for (let i = 0; element && i < 5; i++, element = element.parentElement)
          lineage.push(describe(element));
        return lineage;
      }),
    };
  }, config);
  await writeFile(structurePath, JSON.stringify(structure, null, 2) + "\n", { mode: 0o600 });
  const mask = await page.addStyleTag({
    content:
      'input, textarea, [contenteditable="true"] { visibility: hidden !important; } * { animation: none !important; transition: none !important; }',
  });
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } finally {
    await mask.evaluate((element) => element.remove()).catch(() => {});
    await mask.dispose();
  }
  return { screenshotPath, structurePath };
}

/** Uses the same public Chromium navigation and extraction as the source form. */
export async function diagnoseScraping(
  args: string[],
  service = new ScrapingService(),
  output = defaultOutput,
): Promise<void> {
  args = [...args];
  const cookiesIndex = args.indexOf("--cookies");
  let cookieConsentSelector: string | undefined;
  if (cookiesIndex !== -1) {
    cookieConsentSelector = args[cookiesIndex + 1];
    if (!cookieConsentSelector || cookieConsentSelector.startsWith("--"))
      throw new Error("Le paramètre --cookies attend le sélecteur CSS du bouton de consentement.");
    args.splice(cookiesIndex, 2);
  }
  if (args.length !== 5 && args.length !== 6)
    throw new Error(
      "Utilisation : npm run diagnose:scraping -- URL ARTICLES TITRE LIEN DATE [BOUTON] [--cookies SELECTEUR]",
    );
  const [url, articleSelector, titleSelector, linkSelector, dateSelector, buttonSelector] =
    args as [string, string, string, string, string, string?];
  const config: ScrapingConfig = {
    articleSelector,
    titleSelector,
    linkSelector,
    dateSelector,
    ...(cookieConsentSelector ? { cookieConsentSelector } : {}),
    ...(buttonSelector
      ? ({ mode: "LOAD_MORE", loadMore: { buttonSelector, waitTimeoutMs: 15000 } } as const)
      : ({ mode: "SCROLL", scroll: { maxScrolls: 0, waitAfterScrollMs: 100 } } as const)),
  };
  console.log(
    "Diagnostic de la première page avec Chromium : aucun appel IA, connexion, enregistrement ou email. Le bouton de chargement n'est pas cliqué.",
  );
  await service.validateFirstPage(url, config, async (diagnostic, page) => {
    console.log(`Blocs d'articles : ${diagnostic.articleBlocks}`);
    console.log(
      `Avec titre : ${diagnostic.withTitle} · Avec lien href : ${diagnostic.withLink} · Avec élément de date : ${diagnostic.withDate}`,
    );
    console.log(`Boutons de chargement visibles : ${diagnostic.loadMoreButtons}`);
    console.log(
      `Dans la page entière : titres ${diagnostic.pageTitleMatches} · liens ${diagnostic.pageLinkMatches} · dates ${diagnostic.pageDateMatches} · boutons ${diagnostic.pageButtonMatches}`,
    );
    console.log(
      `Protection/CAPTCHA : ${diagnostic.pageProtection ? "détecté" : "non détecté"} · Consentement visible : ${diagnostic.consentVisible ? "oui" : "non"}`,
    );
    const files = await writeScrapingArtifacts(page, config, output);
    console.log(`Capture de la page reçue : ${files.screenshotPath}`);
    console.log(`Structure des conteneurs : ${files.structurePath}`);
  });
  console.log("Extraction de la première page : OK.");
}

if (import.meta.main) {
  try {
    await diagnoseScraping(process.argv.slice(2).filter((arg) => arg !== "--"));
  } catch (error) {
    console.error(
      error instanceof AppError
        ? `${error.code} : ${error.message}`
        : "Diagnostic impossible. Vérifiez l'URL et les cinq ou six arguments attendus.",
    );
    process.exitCode = 1;
  }
}
