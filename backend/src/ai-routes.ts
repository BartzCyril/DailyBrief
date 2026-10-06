import { Router } from "express";
import { requireAuth } from "./auth";
import { summaryInputSchema, type SummaryProvider, OllamaClient } from "./ai";
export function aiRouter(provider: SummaryProvider, client: OllamaClient) {
  const router = Router(); router.use(requireAuth);
  router.post("/summarize/test", async (req, res) => res.json(await provider.summarize(summaryInputSchema.parse(req.body))));
  router.get("/health", async (_req, res) => res.json({ status: await client.health() }));
  return router;
}
