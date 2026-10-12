import { ScrapingService } from "../src/scraping";
import { AppError } from "../src/errors";
import type { ScrapingConfig } from "@dailybrief/shared";

/** Uses the same public Chromium navigation and extraction as the source form. */
export async function diagnoseScraping(
  args: string[],
  service = new ScrapingService(),
): Promise<void> {
  if (args.length !== 5 && args.length !== 6)
    throw new Error(
      "Utilisation : npm run diagnose:scraping -- URL ARTICLES TITRE LIEN DATE [BOUTON]",
    );
  const [url, articleSelector, titleSelector, linkSelector, dateSelector, buttonSelector] =
    args as [string, string, string, string, string, string?];
  const config: ScrapingConfig = {
    articleSelector,
    titleSelector,
    linkSelector,
    dateSelector,
    ...(buttonSelector
      ? ({ mode: "LOAD_MORE", loadMore: { buttonSelector, waitTimeoutMs: 15000 } } as const)
      : ({ mode: "SCROLL", scroll: { maxScrolls: 0, waitAfterScrollMs: 100 } } as const)),
  };
  console.log(
    "Diagnostic de la première page avec Chromium : aucun appel IA, connexion, enregistrement ou email. Le bouton de chargement n'est pas cliqué.",
  );
  await service.validateFirstPage(url, config, (diagnostic) => {
    console.log(`Blocs d'articles : ${diagnostic.articleBlocks}`);
    console.log(
      `Avec titre : ${diagnostic.withTitle} · Avec lien href : ${diagnostic.withLink} · Avec élément de date : ${diagnostic.withDate}`,
    );
    console.log(`Boutons de chargement visibles : ${diagnostic.loadMoreButtons}`);
    console.log(
      `Protection/CAPTCHA : ${diagnostic.pageProtection ? "détecté" : "non détecté"} · Consentement visible : ${diagnostic.consentVisible ? "oui" : "non"}`,
    );
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
