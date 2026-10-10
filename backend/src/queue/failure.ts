import { AppError } from "../errors";
import type { CollectionFailure, CollectionStage } from "@dailybrief/shared";
export function failureFor(error: unknown, stage: CollectionStage): CollectionFailure {
  const fallback =
    stage === "ai"
      ? "Échec du résumé IA."
      : stage === "email"
        ? "L'envoi SMTP a échoué. Vérifiez la configuration du serveur mail."
        : stage === "content"
          ? "La récupération du contenu complet de l'article a échoué."
          : "Échec du pipeline DailyBrief.";
  return {
    stage,
    code: error instanceof AppError ? error.code : "PIPELINE_FAILED",
    message: error instanceof AppError ? error.message : fallback,
  };
}
