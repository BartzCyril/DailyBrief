import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { logger } from "./logger";
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}
export class UpstreamHttpError extends AppError {
  constructor(
    public readonly upstreamStatus: number,
    public readonly url: string,
  ) {
    super(502, `Le site a retourné HTTP ${upstreamStatus} pour ${url}.`, "UPSTREAM_ERROR");
  }
}
export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      message: "Données invalides.",
      code: "VALIDATION_ERROR",
      fields: error.flatten().fieldErrors,
    });
    return;
  }
  if (error instanceof AppError) {
    if (error.status >= 500)
      logger.error("http.service_failed", "Un service nécessaire à la requête est indisponible.", {
        status: error.status,
        error,
      });
    else
      logger.debug("http.rejected", "Requête refusée.", { status: error.status, code: error.code });
    res.status(error.status).json({
      message: error.message,
      code: error.code,
      ...(error instanceof UpstreamHttpError
        ? { upstreamStatus: error.upstreamStatus, url: error.url }
        : {}),
    });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    res.status(409).json({ message: "Cette entrée existe déjà.", code: "DUPLICATE" });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ message: "JSON invalide." });
    return;
  }
  logger.error("http.failed", "Erreur interne pendant une requête HTTP.", { error });
  res.status(500).json({ message: "Une erreur interne est survenue.", code: "INTERNAL_ERROR" });
};
