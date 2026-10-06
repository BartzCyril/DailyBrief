import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Db } from "./db";
import type { Config } from "./config";
import { AppError } from "./errors";
declare module "express-session" { interface SessionData { userId: string } }

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.session.userId) { next(new AppError(401, "Connectez-vous pour continuer.", "UNAUTHORIZED")); return; }
  next();
};
const loginSchema = z.object({ email: z.email().trim().toLowerCase(), password: z.string().min(1).max(128) }).strict();
const registerSchema = loginSchema.extend({ password: z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/) });
const sessionAction = (action: (callback: (error?: unknown) => void) => void) => new Promise<void>((resolve, reject) => action(error => error ? reject(error) : resolve()));

export function authRouter(db: Db, config: Config) {
  const router = Router();
  router.use(["/login", "/register"], rateLimit({ windowMs: 900000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false, message: { message: "Trop de tentatives. Réessayez plus tard." } }));
  router.post("/register", async (req, res) => {
    const input = registerSchema.parse(req.body);
    const existing = await db.user.findUnique({ where: { email: input.email } });
    if (existing) throw new AppError(409, "Impossible de créer ce compte.", "DUPLICATE");
    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
    const user = await db.user.create({ data: { email: input.email, passwordHash, settings: { create: {} } }, select: { id: true, email: true } });
    res.status(201).json(user);
  });
  // A dummy hash keeps password verification work comparable for unknown emails.
  const dummyHash = Bun.password.hash("Unused-password-9381", { algorithm: "argon2id" });
  router.post("/login", async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { email: input.email } });
    const valid = await Bun.password.verify(input.password, user?.passwordHash ?? await dummyHash);
    if (!user || !valid) throw new AppError(401, "Email ou mot de passe incorrect.", "INVALID_CREDENTIALS");
    await sessionAction(callback => req.session.regenerate(callback));
    req.session.userId = user.id;
    await sessionAction(callback => req.session.save(callback));
    res.json({ id: user.id, email: user.email });
  });
  router.get("/me", requireAuth, async (req, res) => {
    const user = await db.user.findUnique({ where: { id: req.session.userId! }, select: { id: true, email: true } });
    if (!user) throw new AppError(401, "Session expirée.", "UNAUTHORIZED");
    res.json(user);
  });
  router.post("/logout", async (req, res) => {
    await sessionAction(callback => req.session.destroy(callback));
    res.clearCookie(config.SESSION_COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", path: "/" });
    res.status(204).end();
  });
  return router;
}
