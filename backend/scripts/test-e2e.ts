import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";
import { chromium } from "playwright";
import { createApp } from "../src/app";
import { createDb } from "../src/db";
import { createRedis } from "../src/redis";
import { readConfig } from "../src/config";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { NewsletterEmailService, type NewsletterMessage } from "../src/email";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a dedicated _test database");
const config = readConfig({
  ...process.env,
  DATABASE_URL: url,
  PORT: "3001",
  FRONTEND_ORIGIN: "http://127.0.0.1:5174",
  NODE_ENV: "test",
});
const db = createDb(url);
const redis = createRedis(config.REDIS_URL);
await redis.connect();
const messages: NewsletterMessage[] = [];
let releaseSummary = () => {};
const summaryGate = new Promise<void>((resolve) => {
  releaseSummary = resolve;
});
const sender = new NewsletterEmailService(
  config,
  nodemailer.createTransport({ jsonTransport: true }),
);
const app = createApp(db, redis, config, {
  rss: new RssService(
    async () =>
      "<rss><channel><title>Flux de test</title><item><title>Article RSS</title><link>https://fixture.example/rss-article</link><description>Informations RSS contrôlées.</description></item></channel></rss>",
  ),
  scraping: new ScrapingService(
    async () =>
      '<article><h2>Article scraping</h2><a href="/scraped-article">Lire</a><p>Informations scraping contrôlées.</p></article>',
  ),
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
  await page.getByRole("link", { name: "Ajouter un flux RSS" }).click();
  await page.getByLabel("URL du flux RSS").fill("https://fixture.example/feed");
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await page.getByText("Article RSS", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Enregistrer le flux" }).click();
  await page.waitForURL("**/dashboard");
  await page.getByRole("link", { name: "Ajouter une source de scraping" }).click();
  await page.getByLabel("URL du site").fill("https://fixture.example/news");
  await page.getByLabel("Sélecteur des articles", { exact: true }).fill("article");
  await page.getByLabel("Sélecteur du titre", { exact: true }).fill("h2");
  await page.getByLabel("Sélecteur du lien", { exact: true }).fill("a");
  await page.getByLabel("Nombre maximum de scrolls").fill("0");
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await page.getByText("Article scraping", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Enregistrer la source" }).click();
  await page.waitForURL("**/dashboard");
  await page.getByRole("switch", { name: "Récupération automatique", exact: true }).click();
  await page.getByLabel("Heure quotidienne").fill("08:45");
  await page.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await page.getByText("Réglages enregistrés.").waitFor();
  await page.getByRole("button", { name: "Récupérer maintenant" }).click();
  await page.getByText("Envoi à l'IA : Article RSS", { exact: true }).waitFor();
  assert.equal(messages.length, 0, "Live AI progress must be visible before SMTP runs");
  assert(await page.getByRole("button", { name: "Collecte en cours…" }).isDisabled());
  await page.screenshot({ path: "/tmp/dailybrief-collection-live.png", fullPage: true });
  releaseSummary();
  await page.getByText("Votre newsletter a été envoyée.").waitFor();
  await page
    .getByRole("log", { name: "Étapes de la collecte" })
    .getByText("Newsletter acceptée par le serveur mail.")
    .waitFor();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.to, email);
  assert(messages[0]?.text.includes("Article RSS"));
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
  await page.screenshot({ path: "/tmp/dailybrief-dashboard-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/dailybrief-dashboard-mobile.png", fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Mobile layout should not overflow horizontally",
  );
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL("**/login");
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  console.info(
    "E2E passed: register, login, RSS, browser scraping, settings, live collection through proxy before AI finishes, newsletter, idempotent retry, mobile layout, logout. AI and SMTP use deterministic test transports.",
  );
} finally {
  releaseSummary();
  await browser.close();
  frontend.kill("SIGTERM");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
  await redis.quit();
}
