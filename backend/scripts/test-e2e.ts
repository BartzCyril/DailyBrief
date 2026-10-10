import { strict as assert } from "node:assert";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";
import { chromium } from "playwright";
import { createApp } from "../src/app";
import { JobsManager } from "../src/queue/jobs-manager";
import { startConsumers } from "../src/queue/consumers";
import { ScrapingSummaryProcessor } from "../src/queue/scraping-summary";
import { SourceCollector } from "../src/collection";
import { DailyBriefPipelineService } from "../src/pipeline";
import { UserCollectionLock } from "../src/lock";
import { JournalAccessService, JournalSecretCipher } from "../src/journal-access";
import { ArticleContentService } from "../src/article-content";
import { JournalLoginBrowser } from "../src/journal-login";
import { journalFixture, loginConfig, fullText } from "../tests/fixtures/journal-login";
import { createDb } from "../src/db";
import { createRedis } from "../src/redis";
import { readConfig } from "../src/config";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { UpstreamHttpError } from "../src/errors";
import { NewsletterEmailService, type NewsletterMessage } from "../src/email";
import { OllamaClient } from "../src/ai";
import { OllamaSelectorAnalysisProvider } from "../src/selector-analysis";
import { SmtpSelectorHelpSender, type SelectorHelpMessage } from "../src/selector-support";
import { AppError } from "../src/errors";
import type { FetchPage } from "../src/network";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a dedicated _test database");
const config = readConfig({
  ...process.env,
  DATABASE_URL: url,
  PORT: "3001",
  FRONTEND_ORIGIN: "http://127.0.0.1:5174",
  NODE_ENV: "test",
  QUEUE_PREFIX: `test-e2e-${randomUUID()}`,
  SMTP_USER: "selector-help@example.test",
  JOURNAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
});
const db = createDb(url);
const redis = createRedis(config.REDIS_URL);
await redis.connect();
const messages: NewsletterMessage[] = [];
const helpMessages: SelectorHelpMessage[] = [];
const selectorPrompts: string[] = [];
let selectorAiFailure = false;
let selectorMailFailure = false;
const scrapingRequests: string[] = [];
const articleRequests: string[] = [];
let releaseSummary = () => {};
const summaryGate = new Promise<void>((resolve) => {
  releaseSummary = resolve;
});
const sender = new NewsletterEmailService(
  config,
  nodemailer.createTransport({ jsonTransport: true }),
);
const loginFixture = journalFixture();
const noticeHtml =
  '<article><p>Notice de bibliothèque à ne pas résumer.</p><a class="accessToPrimaryDoc primarydoc" target="_blank" href="https://publisher.example/full-article">Consulter le document</a></article>';
const testRss = new RssService(
  async () =>
    "<rss><channel><title>Flux de test</title><item><title>Article RSS</title><link>https://fixture.example/rss-article</link><description>Informations RSS contrôlées.</description></item></channel></rss>",
);
const selectorPage: FetchPage = async (url, options) => {
  assert(
    !options?.method || options.method === "GET",
    "Selector analysis must never submit a form",
  );
  if (url === "https://publisher.example/")
    return {
      url,
      status: 200,
      cookies: [],
      contentType: "text/html",
      text: '<main><a href="/login">Se connecter</a></main>',
    };
  if (url === loginConfig.loginUrl) return loginFixture.fetch(url, options);
  return {
    url,
    status: 200,
    cookies: [],
    contentType: "text/html",
    text: url.includes("rss-article")
      ? noticeHtml
      : '<main><article><h2>Article scraping</h2><a href="/scraped-article">Lire</a><p>Informations scraping contrôlées.</p><time datetime="2026-10-09">9 octobre 2026</time></article><button class="more">Charger plus</button></main>',
  };
};
const selectorClient = new OllamaClient(config, async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  selectorPrompts.push(body.prompt);
  assert.equal(body.think, false);
  assert.equal(body.options.temperature, 0);
  assert.equal(body.options.num_ctx, 8192);
  if (selectorAiFailure) return new Response("{}", { status: 503 });
  const fields = body.format.anyOf[0].properties;
  const suggestion = fields.articleLinkSelector
    ? { articleLinkSelector: "a.accessToPrimaryDoc.primarydoc" }
    : fields.emailSelector
      ? { emailSelector: "#email", passwordSelector: "#password", submitSelector: "#submit" }
      : {
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "a",
          descriptionSelector: "p",
          dateSelector: "time",
          mode: "LOAD_MORE",
          loadMore: { buttonSelector: ".more", waitTimeoutMs: 10000 },
        };
  return new Response(JSON.stringify({ done: true, response: JSON.stringify(suggestion) }));
});
const helpSender = new SmtpSelectorHelpSender(
  config,
  nodemailer.createTransport({ jsonTransport: true }),
);
const services = {
  selectorAnalysis: new OllamaSelectorAnalysisProvider(config, {
    client: selectorClient,
    fetchPage: selectorPage,
    rss: testRss,
  }),
  selectorHelpSender: {
    async send(message) {
      if (selectorMailFailure)
        throw new AppError(503, "Envoi de la demande impossible. Réessayez.", "SMTP_FAILED");
      await helpSender.send(message);
      helpMessages.push(message);
    },
  },
  journalLogin: new JournalLoginBrowser((url, options) =>
    loginFixture.fetch(url.replace("/full-article", "/article"), options),
  ),
  articleContent: new ArticleContentService(async (url) => {
    articleRequests.push(url);
    if (url === "https://fixture.example/rss-article") return noticeHtml;
    return `<article><h1>Article complet</h1><p>${"Ces informations complètes viennent de la page liée et complètent le flux RSS. ".repeat(12)} Information finale conservée.</p></article>`;
  }),
  rss: testRss,
  scraping: new ScrapingService(async (url) => {
    scrapingRequests.push(url);
    const offset = new URL(url).searchParams.get("offset");
    if (offset !== null && offset !== "0") throw new UpstreamHttpError(404, url);
    if (url.includes("/button-batch/"))
      return JSON.stringify({
        html: url.endsWith("/1")
          ? '<article><h2>Article supplémentaire</h2><a href="/scraped-next">Lire</a></article>'
          : '<article><h2>Dernier article chargé</h2><a href="/scraped-last">Lire</a></article>',
      });
    return `<article><h2>Article scraping</h2><a href="/scraped-article">Lire</a><p>Informations scraping contrôlées.</p><time datetime="2026-10-09">9 octobre 2026</time></article><button id="more" class="more">Plus</button><script>
      let batch=0; const button=document.querySelector('#more');
      button.onclick=async()=>{
        if(button.classList.contains('fetching')) return;
        button.classList.add('fetching');
        fetch('https://metrics.example/event',{method:'POST',body:'click=more'}).catch(()=>{});
        const data=await(await fetch('/button-batch/'+(++batch))).json();
        button.insertAdjacentHTML('beforebegin',data.html);
        if(batch===2) button.remove();
        else setTimeout(()=>button.classList.remove('fetching'),500);
      };</script>`;
  }),
  summary: {
    summarize: async (input) => {
      await summaryGate;
      return {
        title: input.title,
        summary: input.content,
        keyPoints: ["Point clé de test"],
      };
    },
  },
  email: {
    send: async (message) => {
      await sender.send(message);
      messages.push(message);
    },
  },
} satisfies NonNullable<Parameters<typeof createApp>[3]>;
const manager = new JobsManager(db, config);
const journals = new JournalAccessService(
  db,
  services.articleContent,
  new JournalSecretCipher(config.JOURNAL_ENCRYPTION_KEY),
  services.journalLogin,
);
const consumers = await startConsumers(
  db,
  manager,
  (dispatch) =>
    new DailyBriefPipelineService(
      db,
      new SourceCollector(db, services.rss, services.scraping, services.articleContent),
      new UserCollectionLock(redis, 30000),
      services.summary,
      services.email,
      services.articleContent,
      journals,
      dispatch,
    ),
  new ScrapingSummaryProcessor(db, services.summary, services.articleContent, journals),
);
const app = createApp(db, redis, config, {
  ...services,
  collections: manager,
  journalAccess: journals,
});
const server = app.listen(config.PORT, "127.0.0.1");
const frontend = spawn(
  process.execPath,
  ["run", "dev", "--host", "127.0.0.1", "--port", "5174", "--strictPort"],
  {
    cwd: fileURLToPath(new URL("../../frontend", import.meta.url)),
    env: { ...process.env, VITE_API_TARGET: "http://127.0.0.1:3001" },
    stdio: "ignore",
  },
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  headless: true,
});
const email = `e2e-${randomUUID()}@example.test`;
const password = "Password123456";
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:5174")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Vite should start");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("http://127.0.0.1:5174/register");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByLabel("Confirmer le mot de passe").fill(password);
  await page.getByRole("button", { name: "Créer le compte" }).click();
  await page.getByText("Compte créé. Vous pouvez vous connecter.").waitFor();
  await page.getByRole("link", { name: "Se connecter", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  await page.waitForURL("**/dashboard");
  // Navigate to the dedicated journal page and manage journals on mobile.
  await page.getByRole("link", { name: "Journaux", exact: true }).click();
  await page.waitForURL("**/journals");
  await page.setViewportSize({ width: 390, height: 844 });
  const addJournal = page.getByRole("button", { name: "Ajouter un journal", exact: true });
  await addJournal.focus();
  await page.keyboard.press("Enter");
  const addModal = page.getByRole("dialog", { name: "Ajouter un journal", exact: true });
  await addModal.waitFor();
  assert(
    await page
      .getByLabel("Domaine du nouveau journal")
      .evaluate((element) => element === document.activeElement),
  );
  assert(
    await addModal.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight
      );
    }),
    "The modal must stay inside the mobile viewport",
  );
  await page.keyboard.press("Escape");
  await addModal.waitFor({ state: "hidden" });
  assert(await addJournal.evaluate((element) => element === document.activeElement));
  await page.keyboard.press("Enter");
  await page.getByLabel("Domaine du nouveau journal").fill("MANUAL-JOURNAL.EXAMPLE");
  await page.getByRole("button", { name: "Enregistrer le journal", exact: true }).click();
  await page.getByRole("button", { name: "Activer manual-journal.example", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Modifier le domaine manual-journal.example", exact: true })
    .click();
  await page
    .getByLabel("Nouveau domaine pour manual-journal.example")
    .fill("corrected-journal.example");
  assert.equal(await page.getByRole("dialog").getAttribute("aria-describedby"), null);
  await page.getByRole("dialog").screenshot({ path: "/tmp/dailybrief-domain-modal-mobile.png" });
  await page.getByRole("button", { name: "Enregistrer le domaine", exact: true }).click();
  await page
    .getByRole("button", { name: "Activer corrected-journal.example", exact: true })
    .waitFor();
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Journal management must fit the mobile viewport",
  );
  await page.screenshot({ path: "/tmp/dailybrief-journal-management-mobile.png", fullPage: true });
  await page
    .getByRole("button", { name: "Supprimer le journal corrected-journal.example", exact: true })
    .click();
  const journalConfirmation = page.getByRole("alertdialog");
  assert(
    (await journalConfirmation.innerText()).includes(
      "Êtes-vous sûr de vouloir supprimer le journal corrected-journal.example ?",
    ),
  );
  await journalConfirmation.getByRole("button", { name: "Annuler", exact: true }).click();
  await page.getByRole("link", { name: "corrected-journal.example", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Supprimer le journal corrected-journal.example", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Supprimer", exact: true })
    .click();
  await page
    .getByRole("link", { name: "corrected-journal.example", exact: true })
    .waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await page.waitForURL("**/sources");
  await page.getByRole("link", { name: "Ajouter un flux RSS" }).click();
  await page.getByLabel("URL du flux RSS").fill("https://fixture.example/feed");
  const rssAnalysisResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/ai/selectors/analyze"),
  );
  await page.getByRole("button", { name: "Remplir avec l'IA", exact: true }).click();
  const rssAnalysis = await rssAnalysisResponse;
  assert(
    rssAnalysis.ok(),
    `RSS selector analysis failed with HTTP ${rssAnalysis.status()}: ${(await rssAnalysis.json()).message ?? "unknown error"}`,
  );
  await page.getByText(/Lien externe vérifié sur une notice du flux/).waitFor();
  assert.equal(
    await page.getByLabel("Sélecteur du lien vers l'article (facultatif)").inputValue(),
    "a.accessToPrimaryDoc.primarydoc",
  );
  assert.equal(helpMessages.length, 0, "Successful analysis must not send mail");
  assert(await page.getByRole("button", { name: "Enregistrer le flux", exact: true }).isDisabled());
  selectorAiFailure = true;
  await page.getByRole("button", { name: "Remplir avec l'IA", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Le service IA est indisponible" }).waitFor();
  assert.equal(helpMessages.length, 0, "AI failure must not send mail without a click");
  const askHelp = page.getByRole("button", { name: "Envoyer une demande d'aide", exact: true });
  selectorMailFailure = true;
  await askHelp.click();
  await page.getByText("Envoi de la demande impossible. Réessayez.", { exact: true }).waitFor();
  assert.equal(helpMessages.length, 0);
  selectorMailFailure = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await askHelp.focus();
  await page.keyboard.press("Enter");
  await page.getByText(/La demande d.aide a été envoyée/).waitFor();
  assert.equal(helpMessages.length, 1);
  assert.equal(helpMessages[0]?.to, config.SMTP_USER);
  assert.equal(helpMessages[0]?.replyTo, email);
  assert(helpMessages[0]?.text.includes("https://fixture.example/feed"));
  assert(helpMessages[0]?.text.includes("sélecteur CSS"));
  assert(await askHelp.isDisabled());
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Selector assistance must fit mobile",
  );
  await page.screenshot({ path: "/tmp/dailybrief-selector-help-mobile.png", fullPage: true });
  selectorAiFailure = false;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Sélecteur du lien vers l'article (facultatif)").fill("a.primarydoc");
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await page.getByText("Article RSS", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Enregistrer le flux" }).click();
  await page.waitForURL("**/sources");
  await page
    .getByRole("button", { name: "Modifier https://fixture.example/feed", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Sélecteur du lien vers l'article (facultatif)").inputValue(),
    "a.primarydoc",
  );
  await page.getByLabel("URL du flux RSS").fill("https://fixture.example/updated-feed");
  await page
    .getByLabel("Sélecteur du lien vers l'article (facultatif)")
    .fill("a.accessToPrimaryDoc.primarydoc");
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await page.getByText("https://fixture.example/updated-feed", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "SCRAPING", exact: true }).click();
  await page.getByRole("link", { name: "Ajouter une source de scraping" }).click();
  await page.getByLabel("URL du site").fill("https://fixture.example/news");
  await page.getByRole("button", { name: "Remplir avec l'IA", exact: true }).click();
  await page.getByText(/Sélecteurs vérifiés sur les articles présents/).waitFor();
  assert.equal(
    await page.getByLabel("Sélecteur des articles", { exact: true }).inputValue(),
    "article",
  );
  assert.equal(await page.getByLabel("Sélecteur de description").inputValue(), "p");
  assert.equal(await page.getByLabel("Sélecteur de date").inputValue(), "time");
  for (const label of ["Sélecteur de description", "Sélecteur de date"]) {
    assert.equal(await page.getByLabel(label).getAttribute("required"), "");
  }
  assert.equal(await page.getByLabel("Sélecteur du bouton", { exact: true }).inputValue(), ".more");
  assert(
    await page
      .getByRole("combobox", { name: "Mode de récupération" })
      .innerText()
      .then((text) => text.includes("Bouton charger plus")),
  );
  assert(
    await page.getByRole("button", { name: "Enregistrer la source", exact: true }).isDisabled(),
  );
  await page.getByLabel("Sélecteur des articles", { exact: true }).fill("article");
  await page.getByLabel("Sélecteur du titre", { exact: true }).fill("h2");
  await page.getByLabel("Sélecteur du lien", { exact: true }).fill("a");
  await page.getByRole("combobox", { name: "Mode de récupération" }).click();
  await page.getByRole("option", { name: "Bouton charger plus", exact: true }).click();
  await page.getByLabel("Sélecteur du bouton").fill(".more");
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await page.getByText("Article scraping", { exact: true }).waitFor();
  await page.getByText("Article supplémentaire", { exact: true }).waitFor();
  await page.getByText("Dernier article chargé", { exact: true }).waitFor();
  scrapingRequests.length = 0;
  await page.getByRole("button", { name: "Enregistrer la source" }).click();
  await page.waitForURL("**/sources?type=scraping");
  assert.deepEqual(
    scrapingRequests,
    ["https://fixture.example/news"],
    "Creation should validate only the initial page",
  );
  const sourcesBeforeEdit = await db.source.findMany({
    where: { user: { email } },
    orderBy: { id: "asc" },
  });
  await page
    .getByRole("button", { name: "Modifier https://fixture.example/news", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Source editing must fit mobile viewport",
  );
  await page.screenshot({ path: "/tmp/dailybrief-edit-source-mobile.png", fullPage: true });
  await page.getByLabel("URL du site").fill("https://fixture.example/updated-news");
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await page.getByText("https://fixture.example/updated-news", { exact: true }).waitFor();
  const sourcesAfterEdit = await db.source.findMany({
    where: { user: { email } },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    sourcesAfterEdit.map((source) => source.id),
    sourcesBeforeEdit.map((source) => source.id),
  );
  assert.deepEqual(
    sourcesAfterEdit.map((source) => source.scrapingConfig),
    sourcesBeforeEdit.map((source) => source.scrapingConfig),
  );
  await page
    .getByRole("button", { name: "Modifier https://fixture.example/updated-news", exact: true })
    .click();
  await page.getByLabel("Sélecteur des articles", { exact: true }).fill("article");
  await page.getByLabel("Sélecteur du titre", { exact: true }).fill("h2:first-of-type");
  await page.getByLabel("Sélecteur du lien", { exact: true }).fill("a[href]");
  await page.getByLabel("Sélecteur de description").fill("p");
  assert.equal(await page.getByLabel("Sélecteur de date").inputValue(), "time");
  for (const label of ["Sélecteur de description", "Sélecteur de date"]) {
    assert.equal(await page.getByLabel(label).getAttribute("required"), "");
  }
  assert.equal(await page.getByLabel("Sélecteur du bouton").inputValue(), ".more");
  await page.getByLabel("Sélecteur du bouton").fill("#more");
  await page.getByLabel("Délai maximum après un clic (ms)").fill("20000");
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await page.getByText("Article supplémentaire", { exact: true }).waitFor();
  await page.getByText("Dernier article chargé", { exact: true }).waitFor();
  assert.deepEqual(
    await db.source.findMany({ where: { user: { email } }, orderBy: { id: "asc" } }),
    sourcesAfterEdit,
  );
  await page.screenshot({ path: "/tmp/dailybrief-load-more-mobile.png", fullPage: true });
  await page.getByRole("combobox", { name: "Mode de récupération" }).click();
  await page.getByRole("option", { name: "Pagination", exact: true }).click();
  await page.getByLabel("Nom du paramètre").fill("offset");
  await page.getByLabel("Page de départ").fill("0");
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await page.getByText("Article scraping", { exact: true }).waitFor();
  await page.getByText(/Fin de pagination à la page 1.*HTTP 404/).waitFor();
  assert.equal(
    await db.article.count({ where: { user: { email } } }),
    0,
    "Testing edits should not save articles",
  );
  assert.deepEqual(
    await db.source.findMany({ where: { user: { email } }, orderBy: { id: "asc" } }),
    sourcesAfterEdit,
    "Testing edits should not change sources",
  );
  await page.screenshot({
    path: "/tmp/dailybrief-edit-source-settings-mobile.png",
    fullPage: true,
  });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Full source settings must fit mobile viewport",
  );
  scrapingRequests.length = 0;
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await page.getByLabel("URL du site").waitFor({ state: "hidden" });
  assert.deepEqual(
    scrapingRequests,
    ["https://fixture.example/updated-news?offset=0"],
    "Editing should validate only the configured starting page",
  );
  const editedSource = await db.source.findFirstOrThrow({
    where: { user: { email }, type: "SCRAPING" },
  });
  assert.deepEqual(editedSource.scrapingConfig, {
    articleSelector: "article",
    titleSelector: "h2:first-of-type",
    linkSelector: "a[href]",
    descriptionSelector: "p",
    dateSelector: "time",
    mode: "PAGINATE",
    pagination: { strategy: "QUERY_PARAM", queryParam: "offset", startPage: 0 },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Inventory and configuration happen before any content extraction or AI.
  // Exercise SQL filtering and pagination through the real API. Remove these
  // temporary sources before the later article collection.
  const storedSources = await db.source.findMany({ where: { user: { email } } });
  const tableOwnerId = storedSources[0]!.userId;
  const sourceTableFixture = Array.from({ length: 11 }, (_, index) => ({
    id: `table-rss-${randomUUID()}`,
    userId: tableOwnerId,
    type: "RSS" as const,
    url: `https://fixture.example/table-feed/${index + 1}`,
    enabled: index % 2 === 0,
    createdAt: new Date(Date.now() - index * 1000),
  }));
  await db.source.createMany({ data: sourceTableFixture });
  await page.goto(`${config.FRONTEND_ORIGIN}/sources?q=table-feed`);
  const sourceTable = page.getByRole("table", { name: "Sources configurées" });
  await page.getByText("1–5 sur 11 sources").waitFor();
  assert.equal(await sourceTable.getByRole("row").count(), 6);
  assert(await page.getByRole("button", { name: "Page précédente" }).isDisabled());
  await page.getByRole("button", { name: "Page suivante" }).click();
  await page.getByText("Page 2 sur 3").waitFor();
  await page.getByRole("button", { name: "Page suivante" }).click();
  await page.getByText("Page 3 sur 3").waitFor();
  assert.equal(await sourceTable.getByRole("row").count(), 2);
  assert(await page.getByRole("button", { name: "Page suivante" }).isDisabled());
  await page.getByRole("searchbox", { name: "Rechercher une URL" }).fill("TABLE-FEED/1");
  await page.getByText("1–3 sur 3 sources").waitFor();
  assert.equal(await sourceTable.getByRole("row").count(), 4);
  await page.getByRole("combobox", { name: "Statut des sources" }).selectOption("active");
  await page.getByText("1–2 sur 2 sources").waitFor();
  assert.equal(await sourceTable.getByRole("row").count(), 3);
  await page.getByRole("combobox", { name: "Statut des sources" }).selectOption("inactive");
  await page.getByText("1–1 sur 1 source").waitFor();
  assert.equal(await sourceTable.getByRole("row").count(), 2);
  await page.getByRole("combobox", { name: "Statut des sources" }).selectOption("all");
  await page.getByRole("searchbox", { name: "Rechercher une URL" }).fill("");
  const workflowAction = page
    .getByRole("link", { name: "Tester le workflow de A à Z", exact: true })
    .first();
  assert.equal((await workflowAction.textContent())?.trim(), "");
  await workflowAction.focus();
  await page.getByRole("tooltip").waitFor();
  assert((await page.getByRole("tooltip").innerText()).includes("Tester le workflow de A à Z"));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/dailybrief-source-table-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: "/tmp/dailybrief-source-table-mobile.png", fullPage: true });
  await page.getByRole("tab", { name: "RSS", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("tab", { name: "SCRAPING", exact: true })
    .and(page.locator('[aria-selected="true"]'))
    .waitFor();
  await page.getByText("1–1 sur 1 source").waitFor();
  assert.equal(await sourceTable.getByRole("row").count(), 2);
  assert.equal(
    await page.getByRole("link", { name: "Ajouter une source de scraping" }).getAttribute("href"),
    "/sources/new/scraping",
  );
  await db.source.deleteMany({
    where: { userId: tableOwnerId, id: { in: sourceTableFixture.map((source) => source.id) } },
  });
  await page.goto(`${config.FRONTEND_ORIGIN}/sources`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await page.getByRole("link", { name: "Tester le workflow de A à Z" }).last().click();
  await page
    .getByRole("table")
    .waitFor()
    .catch(async (error) => {
      console.info("Journal workflow diagnostic:", await page.locator("main").innerText());
      throw error;
    });
  assert(await page.getByRole("button", { name: "Faire le résumé avec l'IA" }).isDisabled());
  assert.equal(
    articleRequests.filter((url) => url === "https://publisher.example/full-article").length,
    0,
  );
  const journalRow = page.getByRole("row").filter({ hasText: "publisher.example" });
  assert.equal(await journalRow.getByRole("cell").first().textContent(), "1");
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Journal table must fit the mobile viewport with internal scrolling",
  );
  const activateJournal = page.getByRole("button", {
    name: "Activer publisher.example",
    exact: true,
  });
  await activateJournal.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Désactiver publisher.example", exact: true }).waitFor();
  await page.getByRole("button", { name: "Configurer l'accès" }).click();
  await page.getByLabel("Email pour publisher.example").fill("subscriber@example.test");
  await page.getByLabel("Mot de passe", { exact: true }).fill("test-only-journal-password");
  await page.getByRole("button", { name: "Enregistrer les identifiants" }).click();
  await page.getByText(/formulaire à configurer/).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByRole("button", { name: "Faire le résumé avec l'IA" }).click();
  await page
    .getByText(/Configurez le formulaire et les sélecteurs de connexion/)
    .first()
    .waitFor();
  assert.equal(messages.length, 0);
  await page.getByRole("button", { name: "Configurer l'accès" }).click();
  await page.getByRole("button", { name: "Remplir avec l'IA", exact: true }).click();
  await page.getByText(/Champs et bouton vérifiés/).waitFor();
  assert.equal(
    await page.getByLabel("URL du formulaire de connexion").inputValue(),
    loginConfig.loginUrl,
  );
  assert.equal(
    await page.getByLabel("Sélecteur du champ email", { exact: true }).inputValue(),
    "#email",
  );
  assert.equal(await page.getByLabel("Sélecteur visible après connexion").inputValue(), "");
  assert.equal(
    await page.getByLabel("Email pour publisher.example").inputValue(),
    "subscriber@example.test",
  );
  assert.equal(
    loginFixture.requests.filter((request) => request.options?.method === "POST").length,
    0,
  );
  assert.equal(helpMessages.length, 1, "Partial login analysis must wait for a click before email");
  await page.getByRole("button", { name: "Envoyer une demande d'aide", exact: true }).click();
  await page.getByText(/La demande d.aide a été envoyée/).waitFor();
  assert.equal(helpMessages.length, 2);
  assert(helpMessages[1]?.text.includes("Élément visible uniquement après une connexion réussie"));
  assert(
    selectorPrompts.every(
      (prompt) =>
        !prompt.includes("test-only-journal-password") &&
        !prompt.includes("subscriber@example.test"),
    ),
  );
  await page.getByLabel("URL du formulaire de connexion").fill(loginConfig.loginUrl);
  await page
    .getByLabel("Sélecteur du champ email", { exact: true })
    .fill(loginConfig.emailSelector);
  await page
    .getByLabel("Sélecteur du champ mot de passe", { exact: true })
    .fill(loginConfig.passwordSelector);
  await page
    .getByLabel("Sélecteur du bouton de connexion", { exact: true })
    .fill(loginConfig.submitSelector);
  await page.getByLabel("Sélecteur visible après connexion").fill(loginConfig.successSelector);
  await page
    .getByLabel("Sélecteur du contenu intégral (facultatif)")
    .fill(loginConfig.articleContentSelector!);
  assert.equal(await page.getByLabel("Nouveau mot de passe (vide : conserver)").inputValue(), "");
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Journal login settings must fit the mobile viewport",
  );
  assert(
    await page.getByRole("dialog").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const label = element.querySelector("label");
      return (
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight &&
        Number.parseFloat(getComputedStyle(label!).rowGap) >= 8
      );
    }),
    "The scrollable access modal must fit mobile with gaps between labels and inputs",
  );
  await page.getByRole("dialog").screenshot({ path: "/tmp/dailybrief-journal-login-mobile.png" });
  await page.getByRole("button", { name: "Enregistrer les identifiants" }).click();
  await page.getByText("Formulaire configuré · connexion à vérifier", { exact: true }).waitFor();
  const testConnection = page.getByRole("button", { name: "Tester la connexion" });
  await testConnection.focus();
  await page.keyboard.press("Enter");
  await page.getByText(/Connexion vérifiée. La session de test a été fermée/).waitFor();
  assert.equal(messages.length, 0, "A connection test must not send email");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByRole("button", { name: "Supprimer les identifiants" }).click();
  assert(
    (await page.getByRole("alertdialog").innerText()).includes(
      "Êtes-vous sûr de vouloir supprimer ces identifiants de connexion ?",
    ),
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Supprimer", exact: true })
    .click();
  await page.getByText("Non configuré", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/dailybrief-journals-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "Retour aux sources" }).click();
  await page.waitForURL("**/sources");
  await page.getByRole("link", { name: "Journaux", exact: true }).click();
  const savedJournalRow = page
    .getByRole("region", { name: "Journaux", exact: true })
    .getByRole("row")
    .filter({ hasText: "publisher.example" });
  await savedJournalRow.getByRole("link", { name: "publisher.example", exact: true }).waitFor();
  assert.equal(await savedJournalRow.getByRole("cell").first().textContent(), "1");
  assert.equal(await page.getByRole("columnheader", { name: "Email", exact: true }).count(), 0);
  const journalActions = savedJournalRow.getByRole("cell").last().getByRole("button");
  assert.equal(await journalActions.count(), 3);
  for (const action of await journalActions.all()) {
    assert.equal((await action.textContent())?.trim(), "");
    assert.equal(await action.evaluate((element) => getComputedStyle(element).cursor), "pointer");
  }
  assert.equal(
    await savedJournalRow.getByRole("img", { name: "Non configuré", exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole("button", { name: "Actualiser les journaux" }).count(), 0);
  const accessIcon = savedJournalRow.getByRole("button", {
    name: "Configurer l'accès",
    exact: true,
  });
  assert(!(await accessIcon.isDisabled()));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await accessIcon.focus();
  await page.getByRole("tooltip").waitFor();
  assert((await page.getByRole("tooltip").innerText()).includes("Configurer l'accès"));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/dailybrief-journals-compact-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: "/tmp/dailybrief-journals-compact-mobile.png", fullPage: true });
  await accessIcon.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.getByRole("dialog").getByLabel("URL du formulaire de connexion").inputValue(),
    loginConfig.loginUrl,
  );
  await page.getByRole("dialog").getByRole("button", { name: "Annuler", exact: true }).click();
  await page.getByRole("link", { name: "Tableau de bord", exact: true }).click();
  await page.waitForURL("**/dashboard");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("switch", { name: "Récupération automatique", exact: true }).click();
  await page.getByLabel("Heure quotidienne").fill("08:45");
  await page.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await page.getByText("Réglages enregistrés.").waitFor();
  scrapingRequests.length = 0;
  await page.getByRole("button", { name: "Récupérer maintenant" }).click();
  await page.getByText("Envoi à l'IA : Article RSS", { exact: true }).waitFor();
  assert.deepEqual(
    scrapingRequests,
    [
      "https://fixture.example/updated-news?offset=0",
      "https://fixture.example/updated-news?offset=1",
    ],
    "Collection must still visit subsequent pages",
  );
  assert.equal(messages.length, 0, "Live AI progress must be visible before SMTP runs");
  assert(await page.getByRole("button", { name: "Collecte en cours…" }).isDisabled());
  await page.screenshot({ path: "/tmp/dailybrief-collection-live.png", fullPage: true });
  // Reload and navigate while the worker is blocked in AI: progression is durable.
  await page.reload();
  await page.getByLabel("Récupération en cours", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Collecte en cours…" }).isDisabled());
  assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuemax"), "2");
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await page.getByRole("heading", { name: "Jobs de récupération" }).waitFor();
  await page.getByRole("cell", { name: "Article RSS", exact: false }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: "/tmp/dailybrief-jobs-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "Tableau de bord", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  releaseSummary();
  await page.getByText("Votre newsletter a été envoyée.").waitFor();
  await page
    .getByRole("log", { name: "Étapes de la collecte" })
    .getByText("Newsletter acceptée par le serveur mail.")
    .waitFor();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.to, email);
  assert(messages[0]?.text.includes("Information finale conservée."));
  assert(messages[0]?.text.includes("Article RSS"));
  assert(messages[0]?.html.includes('href="https://publisher.example/full-article"'));
  assert(!messages[0]?.text.includes("Notice de bibliothèque à ne pas résumer"));
  assert(articleRequests.includes("https://publisher.example/full-article"));
  assert.equal(
    (await db.source.findFirstOrThrow({ where: { user: { email }, type: "RSS" } }))
      .articleLinkSelector,
    "a.accessToPrimaryDoc.primarydoc",
  );
  assert(messages[0]?.text.includes("Article scraping"));
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Live journal must fit mobile viewport",
  );
  await page.screenshot({ path: "/tmp/dailybrief-collection-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Récupérer maintenant" }).click();
  await page.getByRole("status").filter({ hasText: "Aucun nouvel article à envoyer." }).waitFor();
  assert.equal(messages.length, 1);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  assert.equal(await db.newsletter.count({ where: { userId: user.id, status: "SENT" } }), 1);
  const articlesBeforeTest = await db.article.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await page.getByRole("link", { name: "Tester le workflow de A à Z" }).last().click();
  await page.getByRole("button", { name: "Faire le résumé avec l'IA" }).waitFor();
  await page.getByRole("button", { name: "Faire le résumé avec l'IA" }).click();
  await page.getByRole("region", { name: "Résumé IA de Article RSS" }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Lire l'article original" }).getAttribute("href"),
    "https://publisher.example/full-article",
  );
  await page
    .getByRole("table")
    .getByRole("link", { name: "publisher.example", exact: true })
    .waitFor();
  assert.equal(messages.length, 1, "Testing a delivered article must not send another email");
  assert.deepEqual(
    await db.article.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } }),
    articlesBeforeTest,
  );
  await page.getByRole("button", { name: "Configurer l'accès" }).click();
  await page.getByLabel("Email pour publisher.example").fill("subscriber@example.test");
  await page.getByLabel("Mot de passe", { exact: true }).fill("test-only-journal-password");
  assert.equal(
    await page.getByLabel("URL du formulaire de connexion").inputValue(),
    loginConfig.loginUrl,
  );
  await page.getByRole("button", { name: "Enregistrer les identifiants" }).click();
  await page.getByText("Formulaire configuré · connexion à vérifier", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Refaire le résumé avec l'IA" }).click();
  await page.getByRole("button", { name: "Refaire le résumé avec l'IA" }).waitFor();
  assert(
    (await page.getByRole("region", { name: "Résumé IA de Article RSS" }).innerText()).includes(
      fullText.trim(),
    ),
  );
  assert(
    loginFixture.requests
      .find((request) => request.url.endsWith("/article"))
      ?.options?.cookie?.includes("sid=own-session"),
  );
  assert(
    !(await page
      .locator("main")
      .innerText()
      .then((text) => text.includes("test-only-journal-password"))),
  );
  assert.equal(messages.length, 1, "Authenticated workflow testing must not send email");
  assert.deepEqual(
    await db.article.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } }),
    articlesBeforeTest,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Workflow preview must fit mobile viewport",
  );
  await page.screenshot({ path: "/tmp/dailybrief-workflow-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "Retour aux sources" }).click();
  await page.waitForURL("**/sources");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/dailybrief-sources-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/dailybrief-sources-mobile.png", fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Mobile layout should not overflow horizontally",
  );
  const rssUrl = "https://fixture.example/updated-feed";
  const scrapingUrl = "https://fixture.example/updated-news";
  for (const sourceUrl of [rssUrl, scrapingUrl]) {
    await page
      .getByRole("tab", { name: sourceUrl === rssUrl ? "RSS" : "SCRAPING", exact: true })
      .click();
    for (const action of ["Modifier", "Supprimer"]) {
      const button = page.getByRole("button", { name: `${action} ${sourceUrl}`, exact: true });
      assert.equal(
        (await button.textContent())?.trim(),
        "",
        "Source actions must display only an icon",
      );
      assert.equal(await button.evaluate((element) => getComputedStyle(element).cursor), "pointer");
    }
  }
  await page.getByRole("tab", { name: "RSS", exact: true }).click();
  const activation = page.getByRole("switch", { name: `Activer ${rssUrl}`, exact: true });
  assert.equal(await activation.evaluate((element) => getComputedStyle(element).cursor), "pointer");
  await activation.click();
  await activation.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(await activation.evaluate((element) => getComputedStyle(element).cursor), "pointer");
  await page.screenshot({ path: "/tmp/dailybrief-source-actions-mobile.png", fullPage: true });
  const rssEditTrigger = page.getByRole("button", { name: `Modifier ${rssUrl}`, exact: true });
  await rssEditTrigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Modifier le flux RSS", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert(await rssEditTrigger.evaluate((element) => element === document.activeElement));
  await page.getByRole("tab", { name: "SCRAPING", exact: true }).click();
  await page.getByRole("button", { name: `Supprimer ${scrapingUrl}`, exact: true }).click();
  assert(
    (await page.getByRole("alertdialog").innerText()).includes(
      "Êtes-vous sûr de vouloir supprimer cette source de scraping ?",
    ),
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Annuler", exact: true }).click();
  assert.equal(
    await db.source.count({ where: { userId: user.id } }),
    2,
    "Cancelling deletion must keep sources",
  );
  await page.getByRole("button", { name: `Supprimer ${scrapingUrl}`, exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Supprimer", exact: true })
    .click();
  await page.getByText("Source supprimée.", { exact: true }).waitFor();
  assert.equal(await db.source.count({ where: { userId: user.id } }), 1);
  assert.equal(await db.article.count({ where: { userId: user.id } }), 1);
  assert.equal(await db.newsletter.count({ where: { userId: user.id, status: "SENT" } }), 1);
  await page.getByRole("tab", { name: "RSS", exact: true }).click();
  await page.getByRole("button", { name: `Supprimer ${rssUrl}`, exact: true }).click();
  assert(
    (await page.getByRole("alertdialog").innerText()).includes(
      "Êtes-vous sûr de vouloir supprimer ce flux RSS ?",
    ),
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Supprimer", exact: true })
    .click();
  await page.getByText(/Aucune source configurée/).waitFor();
  assert.equal(await db.source.count({ where: { userId: user.id } }), 0);
  assert.equal(await db.article.count({ where: { userId: user.id } }), 0);
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL("**/login");
  assert.equal(helpMessages.length, 2, "Only the two explicit help requests may send help emails");
  assert(
    helpMessages.every(
      (message) =>
        message.to === config.SMTP_USER && !message.text.includes("test-only-journal-password"),
    ),
  );
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  console.info(
    "E2E passed: RSS, scraping and journal selector autofill through public Chromium and structured AI; partial login and failed AI help on explicit click only, SMTP retry, no credentials in AI, mobile and keyboard assistance; register, login, separate sources and journals navigation, modal journal addition and domain editing, cancellation and confirmed deletion on mobile, persisted inventory counts and access settings, RSS notice-link creation and editing, publisher article extraction and links, mobile journal login settings, keyboard connection test and authenticated article reading, complete scraping settings editing and preview without changes to sources or articles, settings, Redis article jobs with progress restored after reload, mobile jobs monitoring, live full-article collection, newsletter, idempotent retry, source workflow on a delivered article, repeat summary without production changes or email, mobile layout, icon-only source actions, pointer cursor when toggling activation, cancel and confirm deletion, empty sources list, logout. AI and SMTP use deterministic test transports.",
  );
} finally {
  releaseSummary();
  await consumers.close();
  await manager.collections.obliterate({ force: true });
  await manager.summaries.obliterate({ force: true });
  const queueKeys = await manager.connection.keys(`${config.QUEUE_PREFIX}:*`);
  if (queueKeys.length) await manager.connection.del(...queueKeys);
  await manager.close();
  await browser.close();
  frontend.kill("SIGTERM");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const account = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (account) {
    const helpKeys = await redis.keys(`dailybrief:selector-help:user:${account.id}:*`);
    if (helpKeys.length) await redis.del(helpKeys);
  }
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
  await redis.quit();
}
