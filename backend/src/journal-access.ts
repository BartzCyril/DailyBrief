import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { ArticlePreview, JournalAccess, JournalPreview } from "@dailybrief/shared";
import type { JournalAccess as StoredAccess } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Db } from "./db";
import type { ArticleContentService } from "./article-content";
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

export function publicJournal(row: StoredAccess): JournalAccess {
  return {
    domain: row.domain,
    enabled: row.enabled,
    email: row.email,
    hasCredentials: Boolean(row.email && row.encryptedPassword),
    authenticationSupported: false,
  };
}

export class JournalAccessService {
  constructor(
    private db: Db,
    private content: ArticleContentService,
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
    if (access.encryptedPassword)
      throw new AppError(
        422,
        "La connexion automatique à ce journal n'est pas encore prise en charge. Aucun contenu abonné ne sera résumé.",
        "JOURNAL_AUTH_UNSUPPORTED",
      );
    return access;
  }
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    email: z.email().max(320).optional(),
    password: z.string().max(4096).optional(),
    clearCredentials: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => !(body.clearCredentials && (body.email !== undefined || body.password !== undefined)),
  );

export function journalAccessRouter(db: Db, cipher: JournalSecretCipher) {
  const router = Router();
  router.use(requireAuth);
  router.patch("/:domain", async (req, res) => {
    const body = patchSchema.parse(req.body);
    const userId = req.session.userId!;
    const domain = String(req.params.domain);
    if (!/^[a-z0-9.-]+$/.test(domain) || journalDomain(`https://${domain}`) !== domain)
      throw new AppError(400, "Domaine invalide.", "INVALID_DOMAIN");
    const where = { userId_domain: { userId, domain } };
    const existing = await db.journalAccess.findUnique({ where });
    if (!existing) throw new AppError(404, "Journal introuvable.", "JOURNAL_NOT_FOUND");
    if ((body.email !== undefined || body.password) && !(body.enabled ?? existing.enabled))
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
  return router;
}
