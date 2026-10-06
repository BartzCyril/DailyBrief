import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
export class AppError extends Error {
  constructor(public status: number, message: string, public code = "REQUEST_FAILED") { super(message); }
}
export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) { res.status(400).json({ message: "Données invalides.", code: "VALIDATION_ERROR", fields: error.flatten().fieldErrors }); return; }
  if (error instanceof AppError) { res.status(error.status).json({ message: error.message, code: error.code }); return; }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ message: "Cette entrée existe déjà.", code: "DUPLICATE" }); return; }
  if (error instanceof SyntaxError) { res.status(400).json({ message: "JSON invalide." }); return; }
  console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
  res.status(500).json({ message: "Une erreur interne est survenue.", code: "INTERNAL_ERROR" });
};
