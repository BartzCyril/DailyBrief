/** Real UI screenshots with deterministic demo API responses; no database, AI or email calls. */
import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ArticleJobSnapshot,
  CollectionRunSnapshot,
  Source,
  JournalPreview,
  DailyBriefSnapshot,
} from "@dailybrief/shared";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "frontend/public/documentation");
await mkdir(output, { recursive: true });
const port = 5180;
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
  ["bun", "run", "--cwd", "frontend", "dev", "--port", String(port), "--strictPort"],
  { cwd: root, stdout: "ignore", stderr: "pipe" },
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const day = "2026-10-10T07:30:00.000Z";
const titles = [
  "Le cloud de demain",
  "L’IA au service des équipes",
  "Les idées qui font avancer la culture",
];
const scrapingConfig = {
  articleSelector: ".article-card",
  titleSelector: "h2",
  linkSelector: "h2 a.title",
  descriptionSelector: ".description",
  dateSelector: "time",
  mode: "SCROLL" as const,
  scroll: { maxScrolls: 3, waitAfterScrollMs: 1000 },
};
const sources: Source[] = [
  {
    id: "rss-culture",
    url: "https://culture.exemple.fr/feed.xml",
    type: "RSS",
    enabled: true,
    scrapingConfig: null,
  },
  {
    id: "rss-bibliotheque",
    url: "https://bibliotheque.exemple.fr/veille.xml",
    type: "RSS",
    enabled: true,
    scrapingConfig: null,
    articleLinkSelector: "a.accessToPrimaryDoc.primarydoc",
  },
  {
    id: "rss-sciences",
    url: "https://sciences.exemple.fr/rss",
    type: "RSS",
    enabled: false,
    scrapingConfig: null,
  },
  {
    id: "rss-technologie",
    url: "https://technologie.exemple.fr/feed.xml",
    type: "RSS",
    enabled: true,
    scrapingConfig: null,
  },
  {
    id: "rss-cloud",
    url: "https://cloud.exemple.fr/rss",
    type: "RSS",
    enabled: true,
    scrapingConfig: null,
  },
  {
    id: "rss-economie",
    url: "https://economie.exemple.fr/rss.xml",
    type: "RSS",
    enabled: false,
    scrapingConfig: null,
  },
  {
    id: "scraping-cloud",
    url: "https://actualites.exemple.fr/cloud",
    type: "SCRAPING",
    enabled: true,
    scrapingConfig,
  },
];
const journals: JournalPreview[] = [
  {
    domain: "www.lemonde.fr",
    enabled: true,
    count: 12,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
  },
  {
    domain: "www.lefigaro.fr",
    enabled: false,
    count: 7,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
  },
  {
    domain: "www.lejournaldesarts.fr",
    enabled: false,
    count: 3,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
  },
];
const run: CollectionRunSnapshot = {
  id: "demo-collection",
  trigger: "manual",
  state: "active",
  active: true,
  startedAt: day,
  finishedAt: null,
  total: 15,
  completed: 10,
  failed: 0,
  skipped: 1,
  events: [
    {
      stage: "collection",
      status: "completed",
      message: "15 articles distincts recensés dans 2 sources.",
      at: day,
    },
    {
      stage: "ai",
      status: "running",
      message: "10/15 articles traités · résumé IA en cours.",
      at: day,
      completed: 10,
      total: 15,
    },
  ],
  result: null,
  error: null,
};
const brief: DailyBriefSnapshot = {
  id: "demo-brief",
  runId: run.id,
  date: "2026-10-10",
  timezone: "Europe/Paris",
  status: "READY",
  articleCount: 3,
  error: null,
  createdAt: day,
  content: {
    headline: "L’IA et le cloud passent à l’échelle des équipes",
    lead: "Des outils plus accessibles et des infrastructures mieux adaptées rapprochent les nouveaux usages du quotidien des organisations.",
    stories: [
      {
        title: "Le cloud évolue pour accompagner les nouveaux usages",
        text: "Les acteurs du cloud présentent des offres adaptées aux besoins des équipes. La souplesse des infrastructures devient un enjeu central pour déployer de nouveaux outils sans multiplier les contraintes.",
        articleIds: ["article-demo-1"],
      },
      {
        title: "L’IA se rapproche des métiers",
        text: "Les équipes expérimentent des assistants dans leurs tâches courantes. Le sujet dépasse la performance du modèle : l’intégration aux méthodes de travail détermine son utilité.",
        articleIds: ["article-demo-2"],
      },
    ],
    otherNews: [
      {
        title: "La culture explore d’autres formes de transmission",
        text: "De nouvelles initiatives facilitent la découverte et le partage des œuvres.",
        articleIds: ["article-demo-3"],
      },
    ],
    trends:
      "Un fil commun : rendre les nouveaux outils accessibles et privilégier des usages concrets plutôt que la seule nouveauté technique.",
  },
};
const manifest: Record<string, { width: number; height: number }> = {};
let authenticated = true;
let showRun = false;
let assistanceIncomplete = false;
let requests = 0;
async function capture(
  page: Page,
  name: string,
  target = page.locator("main"),
  includeNotifications = false,
) {
  // Transient toasts sit outside main/dialog and otherwise get cut by element screenshots.
  // Keep them only in the full-page assistance example that demonstrates an AI error.
  if (!includeNotifications) {
    const closeButtons = page.getByRole("button", {
      name: "Fermer la notification",
      exact: true,
    });
    for (let i = (await closeButtons.count()) - 1; i >= 0; i--) {
      const close = closeButtons.nth(i);
      await close.click();
      await close.waitFor({ state: "hidden" });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Capture absente : ${name}`);
  await target.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  manifest[name] = { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  console.log(`Capture ${name} : ${manifest[name].width} × ${manifest[name].height}`);
}
try {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null)
      throw new Error(`Vite ne démarre pas : ${await new Response(server.stderr).text()}`);
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      /* Wait for Vite's listener. */
    }
    await Bun.sleep(100);
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    requests++;
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const respond = (json: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
    if (path === "/auth/me")
      return authenticated
        ? respond({ id: "demo-user", email: "demo@dailybrief.example" })
        : respond({ message: "Non connecté" }, 401);
    if (path === "/collection/current") return respond(showRun ? run : null);
    if (path === "/collection/runs") return respond([run]);
    if (path === "/collection/runs/demo-collection") return respond(run);
    if (path === "/collection/runs/demo-collection/jobs") {
      const jobs: ArticleJobSnapshot[] = Array.from({ length: 15 }, (_, i) => {
        const completed = i < 2 || (i >= 5 && i < 13);
        const skipped = i === 1;
        return {
          id: `demo-job-${i}`,
          articleId: `article-demo-${i + 1}`,
          title: titles[i % titles.length]!,
          sourceUrl: sources[i % 2]!.url,
          state: completed ? "completed" : i === 2 ? "active" : "waiting",
          attempts: completed || i === 2 ? 1 : 0,
          skipped,
          progress:
            i === 2
              ? { stage: "ai", status: "running", message: "Résumé IA en cours", at: day }
              : null,
          error: null,
          relevanceReason: skipped ? "Article sans lien avec les centres d’intérêt choisis." : null,
          summary:
            completed && !skipped
              ? {
                  title: titles[i % titles.length]!,
                  summary:
                    "Les acteurs du secteur présentent de nouvelles solutions. Cet exemple illustre le résumé IA enregistré après la récupération complète de l’article.",
                  keyPoints: [
                    "Les informations essentielles sont conservées.",
                    "Le résumé peut être consulté sans relancer l’IA.",
                  ],
                }
              : null,
        };
      });
      const params = new URL(route.request().url()).searchParams;
      const status = params.get("status") ?? "all";
      const filtered = jobs.filter(
        (job) =>
          status === "all" ||
          (status === "skipped" ? job.skipped : job.state === status && !job.skipped),
      );
      const page = Math.min(
        Number(params.get("page") ?? 1),
        Math.max(1, Math.ceil(filtered.length / 5)),
      );
      return respond({
        jobs: filtered.slice((page - 1) * 5, page * 5),
        total: filtered.length,
        page,
        pageSize: 5,
      });
    }
    if (path === "/sources") {
      const params = new URL(route.request().url()).searchParams;
      const filtered = sources.filter(
        (source) =>
          (!params.get("type") || source.type === params.get("type")) &&
          (!params.get("status") || source.enabled === (params.get("status") === "active")) &&
          source.url.toLowerCase().includes((params.get("q") ?? "").toLowerCase()),
      );
      const total = filtered.length;
      const page = Math.min(Number(params.get("page") ?? 1), Math.max(1, Math.ceil(total / 5)));
      return respond({
        sources: filtered.slice((page - 1) * 5, page * 5),
        total,
        page,
        pageSize: 5,
      });
    }
    if (path === "/journals")
      return respond({ journals, lastInventoriedAt: day, unresolvedCount: 0 });
    if (path === `/dailybrief/${brief.id}/articles`) {
      const articles = titles.map((title, index) => ({
        id: `article-demo-${index + 1}`,
        title,
        url: `https://articles.exemple.fr/article-${index + 1}`,
        publishedAt: day,
        summary:
          "Cet exemple présente les informations essentielles de l’article retenu pour la revue quotidienne. Le résumé reste accessible sans nouvel appel à l’IA.",
        keyPoints: [
          "Les faits principaux sont synthétisés.",
          "Le lien original permet d’approfondir.",
        ],
      }));
      return respond({ articles, total: articles.length, page: 1, pageSize: 5 });
    }
    if (path === "/dashboard")
      return respond({
        sources: {
          total: sources.length,
          rss: sources.filter((source) => source.type === "RSS").length,
          scraping: sources.filter((source) => source.type === "SCRAPING").length,
          enabled: sources.filter((source) => source.enabled).length,
        },
        collection: {
          enabled: true,
          time: "07:00",
          timezone: "Europe/Paris",
          lastRunAt: day,
          nextRunAt: "2026-10-11T05:00:00.000Z",
          interestPrompt:
            "Je souhaite suivre l’IA, le cloud et les nouveaux outils pour les équipes. Je m’intéresse aussi aux initiatives culturelles. Ignore les faits divers et les actualités sans rapport avec ces thèmes.",
        },
        latestBrief: brief,
      });
    if (path === "/ai/selectors/analyze" && assistanceIncomplete)
      return respond(
        { message: "L'analyse n'a pas pu remplir les sélecteurs.", helpRequestId: "demo-help" },
        422,
      );
    if (path === "/ai/selectors/analyze")
      return respond({
        kind: "SCRAPING",
        complete: true,
        scrapingConfig,
        message: "Sélecteurs proposés. Vérifiez les articles avec le bouton Tester.",
      });
    throw new Error(`API de démonstration non prévue : ${path}`);
  });
  await page.goto(`${origin}/sources`);
  await page.getByRole("link", { name: "Ajouter un flux RSS" }).waitFor();
  await page.getByText("https://culture.exemple.fr/feed.xml", { exact: true }).waitFor();
  await page.getByText("1–5 sur 6 sources", { exact: true }).waitFor();
  await capture(page, "sources");
  await page.goto(`${origin}/sources/new/rss`);
  await page.getByLabel("URL du flux RSS").fill("https://culture.exemple.fr/feed.xml");
  await capture(page, "rss");
  await page.goto(`${origin}/sources/new/scraping`);
  await page.getByLabel("URL du site").fill("https://actualites.exemple.fr/cloud");
  await page.getByRole("button", { name: "Remplir avec l'IA" }).click();
  await page.getByText("Sélecteurs remplis.", { exact: true }).waitFor();
  await capture(page, "scraping");
  assistanceIncomplete = true;
  await page.getByRole("button", { name: "Remplir avec l'IA" }).click();
  await page.getByRole("button", { name: "Demander de l'aide" }).waitFor();
  await page.getByText("L'analyse n'a pas pu remplir les sélecteurs.", { exact: true }).waitFor();
  await capture(page, "assistance", page.locator("body"), true);
  await page.goto(`${origin}/journals`);
  await page.getByText("www.lemonde.fr", { exact: true }).waitFor();
  await capture(page, "journaux");
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.getByRole("button", { name: "Configurer l'accès", exact: true }).first().click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("URL du formulaire de connexion").fill("https://www.lemonde.fr/connexion");
  await capture(page, "acces", page.getByRole("dialog"));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("heading", { name: "Votre DailyBrief" }).waitFor();
  await page.getByRole("heading", { name: brief.content!.headline, exact: true }).waitFor();
  await capture(page, "dashboard");
  await page.getByRole("button", { name: "Lire les résumés individuels", exact: true }).click();
  const briefDialog = page.getByRole("dialog", { name: "Résumés individuels", exact: true });
  await briefDialog.getByText("1–3 sur 3 articles", { exact: true }).waitFor();
  await briefDialog.locator("summary").filter({ hasText: titles[0]! }).click();
  await briefDialog.getByRole("heading", { name: "Points clés", exact: true }).waitFor();
  if (await briefDialog.getByRole("button", { name: "Page suivante des résumés" }).isEnabled())
    throw new Error("Une édition de trois articles doit tenir sur une seule page.");
  await page.keyboard.press("Escape");
  await briefDialog.waitFor({ state: "hidden" });
  await page.goto(`${origin}/settings`);
  await page.getByLabel("Heure quotidienne").waitFor();
  await capture(page, "settings");
  await page.getByRole("tab", { name: "Vos centres d’intérêt" }).click();
  await page.getByLabel("Quels articles vous intéressent ?").waitFor();
  await capture(page, "interests");
  showRun = true;
  await page.goto(`${origin}/jobs`);
  await page.getByText("10/15 articles traités · 0 en échec · 1 ignorés").waitFor();
  await page.getByText("1–5 sur 15 articles", { exact: true }).waitFor();
  await capture(page, "jobs");
  await page
    .getByRole("button", { name: "Voir le résumé de Le cloud de demain", exact: true })
    .click();
  const summaryDialog = page.getByRole("dialog", { name: "Résumé IA", exact: true });
  await summaryDialog.getByRole("heading", { name: "Points clés", exact: true }).waitFor();
  await capture(page, "resume", summaryDialog);
  await page.keyboard.press("Escape");
  await writeFile(resolve(output, "screenshots.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Exercise the authenticated shell and table/form widths, including narrow phones.
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of [
      "/dashboard",
      "/settings",
      "/sources",
      "/journals",
      "/jobs",
      "/sources/new/rss",
      "/sources/new/scraping",
    ]) {
      await page.goto(`${origin}${path}`);
      await page.locator("main h1").waitFor();
      await page.getByRole("navigation", { name: "Navigation principale" }).waitFor();
      if (path === "/dashboard")
        await page.getByRole("heading", { name: brief.content!.headline, exact: true }).waitFor();
      else if (path === "/settings") await page.getByLabel("Heure quotidienne").waitFor();
      else if (path === "/sources")
        await page.getByText("1–5 sur 6 sources", { exact: true }).waitFor();
      else if (path === "/journals")
        await page.getByText("www.lemonde.fr", { exact: true }).waitFor();
      else if (path === "/jobs")
        await page.getByText("1–5 sur 15 articles", { exact: true }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Débordement de l’espace utilisateur : ${path} à ${width}px`);
      if (path === "/settings") {
        await page.getByRole("tab", { name: "Vos centres d’intérêt" }).click();
        await page.getByLabel("Quels articles vous intéressent ?").waitFor();
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          throw new Error(`Débordement des centres d’intérêt : ${width}px`);
      }
      if (path === "/dashboard") {
        await page
          .getByRole("button", { name: "Lire les résumés individuels", exact: true })
          .click();
        await briefDialog.getByText("1–3 sur 3 articles", { exact: true }).waitFor();
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          throw new Error(`Débordement de la fenêtre des résumés : ${width}px`);
        await page.keyboard.press("Escape");
        await briefDialog.waitFor({ state: "hidden" });
      }
      if (["/dashboard", "/sources", "/jobs"].includes(path) && (width === 1440 || width === 390))
        await page.screenshot({
          path: `/tmp/dailybrief-app-${path.slice(1)}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
    }
  }
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("heading", { name: brief.content!.headline, exact: true }).waitFor();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Aller au contenu", exact: true });
  if (!(await skip.evaluate((element) => element === document.activeElement)))
    throw new Error("Le lien d’évitement de l’espace utilisateur doit être accessible au clavier.");
  await page.keyboard.press("Enter");
  if (!(await page.locator("main").evaluate((element) => element === document.activeElement)))
    throw new Error("Le lien d’évitement de l’espace utilisateur doit donner le focus au contenu.");
  await page.goto("about:blank");

  // Public routes also work without a session or a backend; test at desktop and mobile sizes.
  authenticated = false;
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/documentation"]) {
      await page.goto(`${origin}${path}`);
      await page.locator("h1").waitFor();
      await page
        .locator(".public-header")
        .getByRole("link", { name: "Se connecter" })
        .waitFor()
        .catch(async (error) => {
          await page.screenshot({ path: "/tmp/dailybrief-documentation-capture-failure.png" });
          throw new Error(
            `Vérification publique interrompue : ${path} à ${width}px. ${errors.join("; ")}`,
            { cause: error },
          );
        });
      await page.evaluate(async () => {
        const images = [...document.querySelectorAll<HTMLImageElement>("main img")];
        await Promise.all(
          images.map((image) => {
            image.loading = "eager";
            return image.decode();
          }),
        );
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Débordement horizontal : ${path} à ${width}px`);
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: `/tmp/dailybrief-${path === "/" ? "home" : "documentation"}-${width}.png`,
          fullPage: path === "/",
          animations: "disabled",
        });
    }
  }
  await page.goto(`${origin}/documentation#selecteurs`);
  const selector = page.getByLabel("Sélecteur à l’intérieur du bloc article");
  await selector.fill(".description");
  await page.getByRole("status").filter({ hasText: "1 élément trouvé" }).waitFor();
  await selector.fill("[");
  await page.getByText("Ce sélecteur CSS n’est pas valide.", { exact: false }).waitFor();
  await selector.fill(".absent");
  await page.getByText("0 élément trouvé", { exact: true }).waitFor();
  await page.getByLabel("Rechercher un chapitre").fill("abonnement");
  const nav = page.getByRole("navigation", { name: "Sommaire de la documentation" });
  if ((await nav.getByRole("link").count()) !== 1)
    throw new Error("Le filtre du guide doit sélectionner le chapitre Journaux.");
  await nav.getByRole("link", { name: "Configurer les journaux" }).click();
  const inView = await page.locator("#journaux").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 120 && rect.top < innerHeight;
  });
  if (!inView) throw new Error("L’ancre doit rester visible sous l’en-tête mobile.");
  await page.goto(`${origin}/`);
  await page.locator("h1").waitFor();
  await page.getByRole("link", { name: "Aller au contenu" }).waitFor({ state: "attached" });
  await page.keyboard.press("Tab");
  if (
    !(await page
      .getByRole("link", { name: "Aller au contenu" })
      .evaluate((element) => element === document.activeElement))
  )
    throw new Error("Le lien d’évitement doit être accessible au clavier.");
  await page.keyboard.press("Enter");
  if (!(await page.locator("main").evaluate((element) => element === document.activeElement)))
    throw new Error("Le lien d’évitement doit donner le focus au contenu.");
  await page.getByRole("link", { name: "Créer ma veille", exact: true }).first().click();
  await page.getByRole("heading", { name: "Créer votre compte" }).waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `Espace utilisateur, accueil et guide vérifiés à 1440, 768, 390 et 320px. Navigation, sélecteurs, ancres, recherche et clavier vérifiés. ${requests} requêtes API simulées, aucun envoi réel.`,
  );
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
}
