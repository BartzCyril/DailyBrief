import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type {
  ArticlePreview,
  JournalAccess,
  JournalPreview,
  JournalLoginConfig,
} from "@dailybrief/shared";
import type { JournalAccess as StoredAccess } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Db } from "./db";
import {
  type ArticleContentService,
  validateArticleLinkSelector,
  extractArticleContent,
  hasSubscriptionMetadata,
} from "./article-content";
import { JournalLoginBrowser } from "./journal-login";
import { isIP } from "node:net";
import { isPublicAddress } from "./network";
import { requireAuth } from "./auth";
import { AppError } from "./errors";

// Exact hostname policy: www and apex hosts never share credentials implicitly.
export function journalDomain(url: string): string {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new AppError(400, "Adresse de journal invalide.", "UNSAFE_URL");
  return target.hostname.toLowerCase().replace(/\.$/, "");
}

export class JournalSecretCipher {
  constructor(private key?: string) {}
  private bytes() {
    if (!this.key || !/^[a-fA-F0-9]{64}$/.test(this.key))
      throw new AppError(
        503,
        "La clé de chiffrement des accès journaux n'est pas configurée.",
        "JOURNAL_KEY_MISSING",
      );
    return Buffer.from(this.key, "hex");
  }
  encrypt(secret: string, userId: string, domain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.bytes(), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([userId, domain])));
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }
  decrypt(secret: string, userId: string, domain: string): string {
    const key = this.bytes();
    try {
      const parts = secret.split(":");
      if (parts.length !== 4 || parts[0] !== "v1") throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64"));
      decipher.setAAD(Buffer.from(JSON.stringify([userId, domain])));
      decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new AppError(
        503,
        "Les identifiants du journal ne peuvent pas être déchiffrés.",
        "JOURNAL_SECRET_INVALID",
      );
    }
  }
}

export function journalLoginConfig(row: StoredAccess): JournalLoginConfig | null {
  if (
    !row.loginUrl ||
    !row.emailSelector ||
    !row.passwordSelector ||
    !row.submitSelector ||
    !row.successSelector
  )
    return null;
  return {
    loginUrl: row.loginUrl,
    emailSelector: row.emailSelector,
    passwordSelector: row.passwordSelector,
    submitSelector: row.submitSelector,
    successSelector: row.successSelector,
    articleContentSelector: row.articleContentSelector,
  };
}
export function journalAccessVersion(row: StoredAccess): string {
  return createHash("sha256")
    .update(JSON.stringify([row.domain, row.email, row.encryptedPassword, journalLoginConfig(row)]))
    .digest("hex");
}
export function publicJournal(row: StoredAccess): JournalAccess {
  return {
    domain: row.domain,
    enabled: row.enabled,
    email: row.email,
    hasCredentials: Boolean(row.email && row.encryptedPassword),
    authenticationSupported: Boolean(journalLoginConfig(row)),
    loginConfig: journalLoginConfig(row),
  };
}

export class JournalAccessService {
  constructor(
    private db: Db,
    private content: ArticleContentService,
    private cipher = new JournalSecretCipher(process.env.JOURNAL_ENCRYPTION_KEY),
    private browser = new JournalLoginBrowser(),
  ) {}
  async ensure(userId: string, domain: string) {
    const where = { userId_domain: { userId, domain } };
    try {
      return await this.db.journalAccess.upsert({ where, create: { userId, domain }, update: {} });
    } catch (error) {
      // An empty-update Prisma upsert may race with another preview's creation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.db.journalAccess.findUnique({ where });
        if (existing) return existing;
      }
      throw error;
    }
  }
  async inventory(userId: string, articles: ArticlePreview[], selector: string) {
    const seen = new Set<string>();
    const resolved: ArticlePreview[] = [];
    const counts = new Map<string, number>();
    for (const article of articles) {
      const identity = article.guid
        ? `guid:${article.guid}`
        : article.url
          ? `url:${article.url}`
          : JSON.stringify(article);
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        const externalUrl = await this.content.resolveLink(article.url, selector);
        const domain = journalDomain(externalUrl);
        resolved.push({ ...article, externalUrl, journalDomain: domain });
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      } catch (error) {
        // Do not expose upstream URLs/query parameters or unexpected transport errors.
        resolved.push({
          ...article,
          externalUrl: null,
          resolutionError:
            error instanceof AppError && error.code.startsWith("ARTICLE_")
              ? error.message
              : "Impossible de résoudre le lien de cette notice.",
        });
      }
    }
    const journals: JournalPreview[] = [];
    for (const [domain, count] of counts)
      journals.push({ ...publicJournal(await this.ensure(userId, domain)), count });
    journals.sort(
      (a, b) => b.count - a.count || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0),
    );
    return { articles: resolved, journals };
  }
  async assertAccessible(userId: string, url: string) {
    const access = await this.ensure(userId, journalDomain(url));
    if (!access.enabled)
      throw new AppError(409, "Article ignoré : ce journal est désactivé.", "JOURNAL_DISABLED");
    if (access.encryptedPassword && !journalLoginConfig(access))
      throw new AppError(
        422,
        "Configurez le formulaire et les sélecteurs de connexion de ce journal avant de récupérer un article avec ces identifiants.",
        "JOURNAL_AUTH_UNSUPPORTED",
      );
    return access;
  }
  private login(access: StoredAccess) {
    const config = journalLoginConfig(access);
    if (!config || !access.email || !access.encryptedPassword)
      throw new AppError(
        422,
        "Configurez le formulaire, l'email et le mot de passe avant de tester la connexion.",
        "JOURNAL_LOGIN_INCOMPLETE",
      );
    return {
      config,
      email: access.email,
      password: this.cipher.decrypt(access.encryptedPassword, access.userId, access.domain),
    };
  }
  async testConnection(userId: string, domain: string) {
    const access = await this.assertAccessible(userId, `https://${domain}`);
    await this.browser.run(domain, this.login(access));
    await this.checkUnchanged(userId, `https://${domain}`, access);
    return {
      authenticated: true,
      message:
        "Connexion vérifiée. La session de test a été fermée ; les prochaines lectures se connecteront à nouveau.",
    };
  }
  private async checkUnchanged(userId: string, url: string, before: StoredAccess) {
    const after = await this.assertAccessible(userId, url);
    if (journalAccessVersion(before) !== journalAccessVersion(after))
      throw new AppError(
        409,
        "L'accès au journal a changé pendant la récupération. Relancez le test.",
        "JOURNAL_ACCESS_CHANGED",
      );
  }
  async fetchArticle(userId: string, url: string, observer?: (message: string) => void) {
    const access = await this.assertAccessible(userId, url);
    let result: { content: string; url: string };
    if (access.encryptedPassword) {
      const login = this.login(access);
      const rendered = await this.browser.run(access.domain, login, url, observer);
      if (hasSubscriptionMetadata(rendered.html) && !login.config.articleContentSelector)
        throw new AppError(
          422,
          "Cet article est réservé aux abonnés. Configurez le sélecteur du contenu intégral pour vérifier la zone à lire après connexion.",
          "JOURNAL_FULL_CONTENT_UNVERIFIED",
        );
      const content = extractArticleContent(rendered.contentHtml ?? rendered.html, rendered.url);
      if (content.includes(login.password))
        throw new AppError(
          422,
          "La réponse du journal ne peut pas être utilisée comme contenu d'article.",
          "JOURNAL_CONTENT_INVALID",
        );
      result = { content, url: rendered.url };
    } else result = await this.content.fetchWithUrl(url, observer, null, access.domain);
    await this.checkUnchanged(userId, url, access);
    return { ...result, accessVersion: journalAccessVersion(access) };
  }
}

const selector = z.string().trim().min(1).max(200);
const loginConfigSchema = z
  .object({
    loginUrl: z.url().max(2048),
    emailSelector: selector,
    passwordSelector: selector,
    submitSelector: selector,
    successSelector: selector,
    articleContentSelector: selector.nullish(),
  })
  .strict();
function validateLoginConfig(config: JournalLoginConfig) {
  const url = new URL(config.loginUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    host === "localhost" ||
    host.endsWith(".local") ||
    (isIP(host) && !isPublicAddress(host)) ||
    [...url.searchParams.keys()].some((name) =>
      /^(password|passwd|access_token|id_token|refresh_token|client_secret|code)$/i.test(name),
    )
  )
    throw new AppError(
      400,
      "Utilisez une URL de formulaire HTTPS publique, sans identifiants ni jeton de session.",
      "JOURNAL_LOGIN_URL_INVALID",
    );
  for (const value of [
    config.emailSelector,
    config.passwordSelector,
    config.submitSelector,
    config.successSelector,
    config.articleContentSelector,
  ]) {
    try {
      validateArticleLinkSelector(value);
    } catch {
      throw new AppError(
        400,
        "Un sélecteur de connexion est invalide. Utilisez des sélecteurs CSS.",
        "JOURNAL_LOGIN_SELECTOR_INVALID",
      );
    }
  }
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    email: z.email().max(320).optional(),
    password: z.string().max(4096).optional(),
    clearCredentials: z.boolean().optional(),
    loginConfig: loginConfigSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (body) => !(body.clearCredentials && (body.email !== undefined || body.password !== undefined)),
  );

export function journalAccessRouter(
  db: Db,
  cipher: JournalSecretCipher,
  service?: JournalAccessService,
) {
  const router = Router();
  router.use(requireAuth);
  router.patch("/:domain", async (req, res) => {
    const body = patchSchema.parse(req.body);
    if (body.loginConfig) validateLoginConfig(body.loginConfig);
    const userId = req.session.userId!;
    const domain = String(req.params.domain);
    if (!/^[a-z0-9.-]+$/.test(domain) || journalDomain(`https://${domain}`) !== domain)
      throw new AppError(400, "Domaine invalide.", "INVALID_DOMAIN");
    const where = { userId_domain: { userId, domain } };
    const existing = await db.journalAccess.findUnique({ where });
    if (!existing) throw new AppError(404, "Journal introuvable.", "JOURNAL_NOT_FOUND");
    if (
      (body.email !== undefined || body.password || body.loginConfig) &&
      !(body.enabled ?? existing.enabled)
    )
      throw new AppError(
        409,
        "Activez le journal avant de configurer ses identifiants.",
        "JOURNAL_DISABLED",
      );
    if (body.password && !(body.email ?? existing.email))
      throw new AppError(
        400,
        "Un email est nécessaire pour configurer les identifiants.",
        "JOURNAL_EMAIL_MISSING",
      );
    if (
      body.email !== undefined &&
      body.email !== existing.email &&
      existing.encryptedPassword &&
      !body.password
    )
      throw new AppError(
        400,
        "Renseignez un nouveau mot de passe pour changer l'email.",
        "JOURNAL_PASSWORD_REQUIRED",
      );
    const row = await db.journalAccess.update({
      where,
      data: {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.loginConfig !== undefined
          ? body.loginConfig
            ? {
                ...body.loginConfig,
                articleContentSelector: body.loginConfig.articleContentSelector ?? null,
              }
            : {
                loginUrl: null,
                emailSelector: null,
                passwordSelector: null,
                submitSelector: null,
                successSelector: null,
                articleContentSelector: null,
              }
          : {}),
        ...(body.clearCredentials
          ? { email: null, encryptedPassword: null }
          : {
              ...(body.email !== undefined ? { email: body.email } : {}),
              ...(body.password
                ? { encryptedPassword: cipher.encrypt(body.password, userId, domain) }
                : {}),
            }),
      },
    });
    res.json(publicJournal(row));
  });
  router.post("/:domain/test", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const domain = String(req.params.domain);
    const access = await db.journalAccess.findUnique({
      where: { userId_domain: { userId: req.session.userId!, domain } },
    });
    if (!access) throw new AppError(404, "Journal introuvable.", "JOURNAL_NOT_FOUND");
    if (!service)
      throw new AppError(
        503,
        "Le test de connexion n'est pas disponible.",
        "JOURNAL_LOGIN_UNAVAILABLE",
      );
    res.json(await service.testConnection(req.session.userId!, domain));
  });
  return router;
}
