/** Real UI screenshots with deterministic demo API responses; no database, AI or email calls. */
import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CollectionRunSnapshot, Source, JournalPreview } from "@dailybrief/shared";

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
  skipped: 0,
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
const manifest: Record<string, { width: number; height: number }> = {};
let authenticated = true;
let showRun = false;
let assistanceIncomplete = false;
let requests = 0;
async function capture(page: Page, name: string, target = page.locator("main")) {
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
    if (path === "/collection/runs/demo-collection/jobs")
      return respond({
        total: 15,
        page: 1,
        pageSize: 10,
        jobs: Array.from({ length: 5 }, (_, i) => ({
          id: `demo-job-${i}`,
          articleId: `article-demo-${i + 1}`,
          title: titles[i % titles.length],
          sourceUrl: sources[i % 2]!.url,
          state: i < 2 ? "completed" : i === 2 ? "active" : "waiting",
          attempts: i < 3 ? 1 : 0,
          skipped: false,
          progress:
            i === 2
              ? { stage: "ai", status: "running", message: "Résumé IA en cours", at: day }
              : null,
          error: null,
        })),
      });
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
    if (path === "/dashboard")
      return respond({
        sources: { total: 4, rss: 3, scraping: 1, enabled: 3 },
        collection: {
          enabled: true,
          time: "07:30",
          timezone: "Europe/Paris",
          lastRunAt: day,
          nextRunAt: "2026-10-11T07:30:00.000Z",
        },
      });
    if (path === "/ai/selectors/analyze")
      return respond({
        kind: "SCRAPING",
        complete: !assistanceIncomplete,
        scrapingConfig,
        helpRequestId: assistanceIncomplete ? "demo-help" : undefined,
        message: assistanceIncomplete
          ? "L’analyse reste incomplète. Vérifiez la date et la description avant d’enregistrer, ou envoyez une demande d’aide."
          : "Sélecteurs proposés. Vérifiez les articles avec le bouton Tester.",
      });
    throw new Error(`API de démonstration non prévue : ${path}`);
  });
  await page.goto(`${origin}/sources`);
  await page.getByRole("link", { name: "Ajouter un flux RSS" }).waitFor();
  await page.getByText("https://culture.exemple.fr/feed.xml", { exact: true }).waitFor();
  await capture(page, "sources");
  await page.goto(`${origin}/sources/new/rss`);
  await page.getByLabel("URL du flux RSS").fill("https://culture.exemple.fr/feed.xml");
  await capture(page, "rss");
  await page.goto(`${origin}/sources/new/scraping`);
  await page.getByLabel("URL du site").fill("https://actualites.exemple.fr/cloud");
  await page.getByRole("button", { name: "Remplir avec l'IA" }).click();
  await page
    .getByText("Sélecteurs proposés. Vérifiez les articles avec le bouton Tester.", { exact: true })
    .waitFor();
  await capture(page, "scraping");
  assistanceIncomplete = true;
  await page.getByRole("button", { name: "Remplir avec l'IA" }).click();
  await page.getByRole("button", { name: "Envoyer une demande d'aide" }).waitFor();
  await capture(page, "assistance");
  await page.goto(`${origin}/journals`);
  await page.getByText("www.lemonde.fr", { exact: true }).waitFor();
  await capture(page, "journaux");
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.getByRole("button", { name: "Configurer l'accès", exact: true }).first().click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("URL du formulaire de connexion").fill("https://www.lemonde.fr/connexion");
  await page.getByLabel("Sélecteur visible après connexion").fill(".mon-compte");
  await capture(page, "acces", page.getByRole("dialog"));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("heading", { name: "Votre DailyBrief" }).waitFor();
  await page.getByLabel("Heure quotidienne").waitFor();
  await capture(page, "dashboard");
  showRun = true;
  await page.goto(`${origin}/jobs`);
  await page.getByText("10/15 articles traités · 0 en échec · 0 ignorés").waitFor();
  await capture(page, "jobs");
  await writeFile(resolve(output, "screenshots.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Public routes also work without a session or a backend; test at desktop and mobile sizes.
  authenticated = false;
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/documentation"]) {
      await page.goto(`${origin}${path}`);
      await page.locator("h1").waitFor();
      await page.locator(".public-header").getByRole("link", { name: "Se connecter" }).waitFor();
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
    `Accueil et guide vérifiés à 1440, 768, 390 et 320px. Sélecteurs, ancres, recherche et clavier vérifiés. ${requests} requêtes API simulées, aucun envoi réel.`,
  );
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
}
