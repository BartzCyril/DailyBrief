import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "./auth";
import type { Db } from "./db";
import { AppError, UpstreamHttpError } from "./errors";
import { SelectorAnalysisFailure, type SelectorAnalysisProvider } from "./selector-analysis";
import type { SelectorHelpService } from "./selector-support";

export const selectorAnalysisInputSchema = z
  .object({
    kind: z.enum(["SCRAPING", "RSS_LINK", "JOURNAL_LOGIN"]),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      }, "Les identifiants ne doivent pas figurer dans l'URL."),
  })
  .strict();
const helpInputSchema = z.object({ helpRequestId: z.uuid() }).strict();

export function selectorAssistanceRouter(
  db: Db,
  analysis: SelectorAnalysisProvider,
  help: SelectorHelpService,
) {
  const router = Router();
  router.use(requireAuth);
  const limit = (count: number, message: string, code: string) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: count,
      keyGenerator: (req) => req.session.userId!,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { message, code },
    });
  router.post(
    "/analyze",
    limit(10, "Trop d'analyses. Réessayez dans quelques minutes.", "SELECTOR_ANALYSIS_RATE_LIMIT"),
    async (req, res) => {
      const input = selectorAnalysisInputSchema.parse(req.body);
      const controller = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) controller.abort();
      };
      // IncomingMessage.close also fires after a normally consumed request body.
      // Only the response socket closing before completion means cancellation.
      res.once("close", disconnected);
      try {
        let result;
        try {
          result = await analysis.analyze(input, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure =
            error instanceof UpstreamHttpError
              ? new AppError(
                  422,
                  `Le site a refusé l'analyse (HTTP ${error.upstreamStatus}).`,
                  "UPSTREAM_ERROR",
                )
              : error instanceof AppError
                ? error
                : new AppError(
                    502,
                    "L'analyse n'a pas pu trouver de sélecteurs fiables. Réessayez ou envoyez une demande d'aide.",
                    "SELECTOR_ANALYSIS_FAILED",
                  );
          const helpRequestId = await help.create(
            req.session.userId!,
            input,
            [],
            error instanceof SelectorAnalysisFailure ? error.analyzedUrl : undefined,
            failure.code,
          );
          if (controller.signal.aborted) return;
          res
            .status(failure.status)
            .json({ message: failure.message, code: failure.code, helpRequestId });
          return;
        }
        if (controller.signal.aborted) return;
        const helpRequestId = !result.complete
          ? await help.create(
              req.session.userId!,
              input,
              result.missingFields,
              result.analyzedUrl,
              "SELECTOR_ANALYSIS_PARTIAL",
            )
          : undefined;
        if (controller.signal.aborted) return;
        res.json({ ...result, ...(helpRequestId ? { helpRequestId } : {}) });
      } finally {
        res.off("close", disconnected);
      }
    },
  );
  router.post(
    "/help",
    limit(
      5,
      "Trop de demandes d'aide. Réessayez dans quelques minutes.",
      "SELECTOR_HELP_RATE_LIMIT",
    ),
    async (req, res) => {
      const { helpRequestId } = helpInputSchema.parse(req.body);
      const user = await db.user.findUnique({
        where: { id: req.session.userId! },
        select: { id: true, email: true },
      });
      if (!user) throw new AppError(401, "Session expirée.", "UNAUTHORIZED");
      res.json(await help.send(user.id, user.email, helpRequestId));
    },
  );
  return router;
}
