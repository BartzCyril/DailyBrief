import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import type { SelectorAnalysisInput, SelectorAnalysisKind } from "@dailybrief/shared";
import type { Config } from "./config";
import { AppError } from "./errors";
import type { Redis } from "./redis";

export type SelectorHelpMessage = {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  messageId?: string;
};

export interface SelectorHelpSender {
  send(message: SelectorHelpMessage): Promise<void>;
}

export class SmtpSelectorHelpSender implements SelectorHelpSender {
  private transport: Transporter;

  constructor(
    private config: Config,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        ...(config.SMTP_USER && config.SMTP_PASSWORD
          ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
          : {}),
      });
  }

  async send(message: SelectorHelpMessage): Promise<void> {
    const recipient = smtpRecipient(this.config);
    try {
      await this.transport.sendMail({
        from: this.config.SMTP_FROM,
        to: recipient,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      // Nodemailer may label a socket timeout CONN even after the server has
      // received DATA. Only an explicit SMTP rejection proves no acceptance;
      // command names alone cannot make retrying safe.
      const responseCode =
        error && typeof error === "object" && "responseCode" in error
          ? error.responseCode
          : undefined;
      if (typeof responseCode === "number" && responseCode >= 400 && responseCode < 600)
        throw new AppError(
          503,
          "L’envoi de la demande d’aide par SMTP a échoué. Réessayez.",
          "SMTP_FAILED",
        );
      throw smtpUncertain();
    }
  }
}

const contextTtlSeconds = 3600;
// Longer than the SMTP connection, greeting and socket timeouts combined.
const sendingLeaseSeconds = 120;
const acknowledgement = { message: "La demande d’aide a été envoyée." };

const configurationNames: Record<SelectorAnalysisKind, string> = {
  SCRAPING: "Source de scraping",
  RSS_LINK: "Lien d’article externe depuis une notice RSS",
  JOURNAL_LOGIN: "Formulaire de connexion à un journal",
};

const fieldNames: Record<SelectorAnalysisKind, Record<string, string>> = {
  SCRAPING: {
    articleSelector: "Bloc répété contenant chaque article (sélecteur CSS)",
    titleSelector: "Titre, à l’intérieur de chaque bloc d’article (sélecteur CSS)",
    linkSelector: "Lien vers l’article, à l’intérieur de chaque bloc (sélecteur CSS)",
    descriptionSelector: "Description ou extrait de l’article (sélecteur CSS, facultatif)",
    dateSelector: "Date de publication (sélecteur CSS, facultatif)",
    mode: "Mode de récupération : défilement, pagination ou bouton de chargement",
    "loadMore.buttonSelector": "Bouton permettant de charger plus d’articles (sélecteur CSS)",
    "pagination.urlTemplate": "Modèle d’URL de pagination avec le numéro de page",
    "pagination.queryParam": "Nom du paramètre d’URL contenant le numéro de page",
  },
  RSS_LINK: {
    articleLinkSelector:
      "Lien de la notice qui mène à l’article sur le site du journal (sélecteur CSS)",
  },
  JOURNAL_LOGIN: {
    loginUrl: "Adresse de la page contenant le formulaire de connexion",
    emailSelector: "Champ d’identifiant ou d’email du formulaire (sélecteur CSS)",
    passwordSelector: "Champ de mot de passe du formulaire (sélecteur CSS)",
    submitSelector: "Bouton qui envoie le formulaire de connexion (sélecteur CSS)",
    successSelector: "Élément visible uniquement après une connexion réussie (sélecteur CSS)",
    articleContentSelector:
      "Contenu intégral d’un article accessible après connexion (sélecteur CSS, facultatif)",
  },
};

const reasonNames: Record<string, string> = {
  INVALID_SELECTOR_AI_RESPONSE: "L’IA n’a pas renvoyé les sélecteurs au format attendu.",
  INVALID_SELECTOR_ANALYSIS:
    "Les sélecteurs proposés ne correspondent pas de manière fiable à la page.",
  SELECTOR_BROWSER_UNAVAILABLE: "Le navigateur d’analyse du serveur était indisponible.",
  SELECTOR_PAGE_BLOCKED: "Le site présente un CAPTCHA ou refuse l’accès automatisé.",
  SELECTOR_NOTICE_MISSING: "Le flux ne contient aucun lien de notice à analyser.",
  SELECTOR_NOTICE_UNAVAILABLE: "Aucune notice du flux n’a pu être chargée.",
  SELECTOR_LOGIN_PAGE_NOT_FOUND: "La page de connexion n’a pas pu être identifiée depuis le site.",
  SELECTOR_LOGIN_URL_UNSTABLE: "Le formulaire dépend d’une URL de connexion temporaire.",
  SELECTOR_AI_INPUT_TOO_SMALL:
    "La limite de contexte IA configurée est trop petite pour cette analyse.",
  TIMEOUT: "Le site a dépassé le délai de chargement.",
  BUSY: "Le service d’analyse était occupé.",
  SELECTOR_ANALYSIS_FAILED: "L’analyse automatique n’a pas permis de compléter la configuration.",
  SELECTOR_ANALYSIS_PARTIAL:
    "L’analyse automatique a trouvé une partie des informations seulement.",
  AI_UNAVAILABLE: "Le service IA était indisponible.",
  AI_TIMEOUT: "Le service IA a dépassé son délai de réponse.",
  MODEL_MISSING: "Le modèle IA configuré n’était pas disponible.",
  INVALID_AI_RESPONSE: "La réponse du service IA ne respectait pas le format attendu.",
  EMPTY_AI_RESPONSE: "Le service IA a renvoyé une réponse vide.",
  INCOMPLETE_AI_RESPONSE: "Le service IA a interrompu sa réponse.",
  UPSTREAM_ERROR: "Le site n’a pas permis de charger la page à analyser.",
  NETWORK_ERROR: "La page à analyser n’a pas pu être chargée.",
  PAGE_TIMEOUT: "Le chargement de la page a dépassé son délai.",
  SELECTOR_PAGE_UNAVAILABLE: "La page à analyser n’a pas pu être chargée.",
  SELECTOR_NOT_FOUND: "Les éléments nécessaires n’ont pas été trouvés dans la page.",
  UNSAFE_URL: "L’adresse n’a pas satisfait les règles d’accès réseau du serveur.",
  REDIRECT_LIMIT: "Le site a effectué trop de redirections.",
  RESPONSE_TOO_LARGE: "La page dépassait la taille de téléchargement autorisée.",
};

type HelpContext = {
  kind: SelectorAnalysisKind;
  url: string;
  analyzedUrl?: string;
  missingFields: string[];
  reasonCode: string;
  state: "pending" | "sending" | "sent" | "uncertain";
  token?: string;
};

/** Retain the useful page address without URL credentials, query tokens or fragments. */
export function sanitizeAssistanceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "L’adresse de la page à analyser est invalide.", "VALIDATION_ERROR");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new AppError(400, "Une adresse HTTP ou HTTPS est requise.", "VALIDATION_ERROR");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function smtpUncertain(): AppError {
  return new AppError(
    502,
    "Livraison SMTP incertaine. Vérifiez auprès de l’administrateur avant de demander un nouvel envoi.",
    "SMTP_UNCERTAIN",
  );
}

function smtpRecipient(config: Config): string {
  const recipient = z.email().safeParse(config.SMTP_USER?.trim());
  if (!recipient.success)
    throw new AppError(
      503,
      "L’envoi d’aide nécessite une adresse email valide dans SMTP_USER. Contactez l’administrateur.",
      "SMTP_USER_INVALID",
    );
  return recipient.data;
}

function requestKeys(userId: string, helpRequestId: string) {
  const context = `dailybrief:selector-help:user:${encodeURIComponent(userId)}:${helpRequestId}`;
  return { context, lock: `${context}:sending` };
}

// Context ownership is part of the key, and state changes and the NX lock are atomic.
const claimScript = `
local raw = redis.call('get', KEYS[1])
if not raw then return cjson.encode({status = 'missing'}) end
local context = cjson.decode(raw)
if context.state == 'sent' then return cjson.encode({status = 'sent'}) end
if context.state == 'uncertain' then return cjson.encode({status = 'uncertain'}) end
if context.state == 'sending' then
  if redis.call('exists', KEYS[2]) == 1 then return cjson.encode({status = 'busy'}) end
  context.state = 'uncertain'
  context.token = nil
  redis.call('set', KEYS[1], cjson.encode(context), 'KEEPTTL')
  return cjson.encode({status = 'uncertain'})
end
if not redis.call('set', KEYS[2], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return cjson.encode({status = 'busy'})
end
context.state = 'sending'
context.token = ARGV[1]
redis.call('set', KEYS[1], cjson.encode(context), 'KEEPTTL')
return cjson.encode({status = 'claimed', context = context})
`;

const finishScript = `
local raw = redis.call('get', KEYS[1])
local updated = 0
if raw then
  local context = cjson.decode(raw)
  if context.state == 'sending' and context.token == ARGV[1] then
    context.state = ARGV[2]
    context.token = nil
    redis.call('set', KEYS[1], cjson.encode(context), 'KEEPTTL')
    updated = 1
  end
end
if redis.call('get', KEYS[2]) == ARGV[1] then redis.call('del', KEYS[2]) end
return updated
`;

export class SelectorHelpService {
  private sender: SelectorHelpSender;

  constructor(
    private redis: Redis,
    private config: Config,
    sender?: SelectorHelpSender,
  ) {
    this.sender = sender ?? new SmtpSelectorHelpSender(config);
  }

  async create(
    userId: string,
    input: SelectorAnalysisInput,
    missingFields: string[] = [],
    analyzedUrl?: string,
    reasonCode?: string,
  ): Promise<string> {
    if (!Object.hasOwn(configurationNames, input.kind))
      throw new AppError(400, "Le type de configuration est invalide.", "VALIDATION_ERROR");
    const availableFields = fieldNames[input.kind];
    const fields = [
      ...new Set(missingFields.filter((field) => Object.hasOwn(availableFields, field))),
    ];
    const context: HelpContext = {
      kind: input.kind,
      url: sanitizeAssistanceUrl(input.url),
      ...(analyzedUrl ? { analyzedUrl: sanitizeAssistanceUrl(analyzedUrl) } : {}),
      missingFields: fields.length ? fields : Object.keys(availableFields),
      reasonCode:
        reasonCode && Object.hasOwn(reasonNames, reasonCode)
          ? reasonCode
          : "SELECTOR_ANALYSIS_FAILED",
      state: "pending",
    };
    const helpRequestId = randomUUID();
    await this.redis.set(requestKeys(userId, helpRequestId).context, JSON.stringify(context), {
      EX: contextTtlSeconds,
      NX: true,
    });
    return helpRequestId;
  }

  async send(
    userId: string,
    userEmail: string,
    helpRequestId: string,
  ): Promise<{ message: string }> {
    if (!z.uuid().safeParse(helpRequestId).success)
      throw new AppError(
        404,
        "Cette demande d’aide est inconnue ou a expiré. Relancez l’analyse.",
        "SELECTOR_HELP_EXPIRED",
      );
    const recipient = smtpRecipient(this.config);
    const replyTo = z.email().safeParse(userEmail);
    if (!replyTo.success)
      throw new AppError(400, "L’adresse email du compte est invalide.", "VALIDATION_ERROR");

    const keys = requestKeys(userId, helpRequestId);
    const token = randomUUID();
    const result = JSON.parse(
      String(
        await this.redis.eval(claimScript, {
          keys: [keys.context, keys.lock],
          arguments: [token, String(sendingLeaseSeconds)],
        }),
      ),
    ) as { status: string; context?: HelpContext };
    if (result.status === "sent") return { ...acknowledgement };
    if (result.status === "uncertain") throw smtpUncertain();
    if (result.status === "busy")
      throw new AppError(
        409,
        "L’envoi de cette demande d’aide est déjà en cours.",
        "SELECTOR_HELP_RUNNING",
      );
    if (result.status !== "claimed" || !result.context)
      throw new AppError(
        404,
        "Cette demande d’aide est inconnue ou a expiré. Relancez l’analyse.",
        "SELECTOR_HELP_EXPIRED",
      );

    const context = result.context;
    const pageLabel =
      context.kind === "RSS_LINK"
        ? "Flux ou notice RSS"
        : context.kind === "JOURNAL_LOGIN"
          ? "Page de connexion"
          : "Page de la source";
    const text = [
      "Demande d’aide à la configuration de DailyBrief",
      "",
      `Demandeur : ${replyTo.data}`,
      `Type de configuration : ${configurationNames[context.kind]}`,
      `${pageLabel} : ${context.url}`,
      ...(context.analyzedUrl && context.analyzedUrl !== context.url
        ? [`Page analysée : ${context.analyzedUrl}`]
        : []),
      "",
      `Motif : ${reasonNames[context.reasonCode]}`,
      "",
      "Informations et sélecteurs à trouver sur le site :",
      ...context.missingFields.map((field) => `- ${fieldNames[context.kind][field]}`),
      "",
      "Les sélecteurs doivent correspondre aux éléments de cette page et être vérifiés avant leur utilisation.",
      "Cette demande ne contient aucun identifiant de connexion ni contenu de page.",
      `Référence de la demande : ${helpRequestId}`,
    ].join("\n");

    let outcome: "sent" | "pending" | "uncertain" = "sent";
    let failure: AppError | undefined;
    try {
      await this.sender.send({
        to: recipient,
        replyTo: replyTo.data,
        subject: `DailyBrief — aide : ${configurationNames[context.kind]} (${new URL(context.url).hostname})`,
        text,
        messageId: `<selector-help-${helpRequestId}@dailybrief.local>`,
      });
    } catch (error) {
      // A known SMTP rejection can be retried. An unknown sender failure may have
      // occurred after delivery, so its request must never be resent automatically.
      failure = error instanceof AppError && error.code === "SMTP_FAILED" ? error : smtpUncertain();
      outcome = failure.code === "SMTP_FAILED" ? "pending" : "uncertain";
    }
    try {
      await this.redis.eval(finishScript, {
        keys: [keys.context, keys.lock],
        arguments: [token, outcome],
      });
    } catch {
      // If delivery finished but Redis cannot record its outcome, the sending
      // state remains conservative and prevents another send after lease expiry.
      throw smtpUncertain();
    }
    if (failure) throw failure;
    return { ...acknowledgement };
  }
}
