import { test, expect, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { emptyDashboard } from "./fixtures";

const source = {
  id: "s1",
  url: "https://example.com/feed",
  type: "RSS",
  enabled: false,
  scrapingConfig: null,
};
const preview = {
  id: "workflow-1",
  source,
  expiresAt: "2026-10-06T12:30:00Z",
  warnings: ["Correction du XML appliquée."],
  articles: [
    {
      title: "Article déjà livré",
      url: "https://example.com/one",
      description: "Extrait RSS",
      publishedAt: null,
    },
    { title: "Article sans lien", url: null, description: null, publishedAt: null },
  ],
};
let failCollect = false;
let failSummary = false;
let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
let holdSummary = false;
let collectCalls = 0;
let summaryCalls = 0;
const result = {
  url: "https://publisher.example/full-article",
  content: "Texte intégral extrait de la page originale.",
  summary: {
    title: "Titre IA",
    summary: "Résumé IA des mesures de l'article complet.",
    keyPoints: ["Mesure détaillée."],
  },
};
function mockApi() {
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ id: "u1", email: "reader@example.com" }));
    if (url.endsWith("/dashboard")) return new Response(JSON.stringify(emptyDashboard));
    if (url.endsWith("/sources")) return new Response(JSON.stringify([source]));
    if (url.endsWith("/workflow")) {
      collectCalls++;
      return new Response(
        JSON.stringify(
          failCollect
            ? { message: "Source inaccessible" }
            : { ...preview, id: `workflow-${collectCalls}` },
        ),
        { status: failCollect ? 502 : 200 },
      );
    }
    if (url.endsWith("/summarize")) {
      summaryCalls++;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          if (!holdSummary) {
            c.enqueue(
              new TextEncoder().encode(
                JSON.stringify(
                  failSummary
                    ? { type: "error", message: "Ollama inaccessible", code: "AI_UNAVAILABLE" }
                    : { type: "result", result },
                ) + "\n",
              ),
            );
            c.close();
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
function mount(path = "/sources/s1/workflow") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  failCollect = failSummary = holdSummary = false;
  collectCalls = summaryCalls = 0;
  controller = undefined;
  mockApi();
});

test("opens a fresh workflow from an inactive source and shows all returned articles", async () => {
  mount("/dashboard");
  await userEvent.click(await screen.findByRole("link", { name: "Tester le workflow de A à Z" }));
  expect(await screen.findByText("1. Article déjà livré")).toBeInTheDocument();
  expect(screen.getByText("2. Article sans lien")).toBeInTheDocument();
  expect(screen.getByText("Correction du XML appliquée.")).toBeInTheDocument();
  expect(collectCalls).toBe(1);
  expect(screen.getAllByRole("button", { name: "Faire le résumé avec l'IA" })[1]).toBeDisabled();
});
test("shows the generated summary, key points and extracted text, and permits fresh regeneration", async () => {
  mount();
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Faire le résumé avec l'IA" }))[0]!,
  );
  const summary = await screen.findByRole("region", { name: "Résumé IA de Article déjà livré" });
  expect(within(summary).getByText("Titre IA")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Lire l'article original" })).toHaveAttribute(
    "href",
    result.url,
  );
  expect(within(summary).getByText(result.summary.summary)).toBeInTheDocument();
  expect(within(summary).getByText("Mesure détaillée.")).toBeInTheDocument();
  await userEvent.click(within(summary).getByText(/Voir le texte extrait/));
  expect(within(summary).getByText(result.content)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Refaire le résumé avec l'IA" }));
  expect(await screen.findByText(result.summary.summary)).toBeInTheDocument();
  expect(summaryCalls).toBe(2);
  expect(collectCalls).toBe(1);
});
test("shows live extraction and AI progress before the summary arrives", async () => {
  holdSummary = true;
  mount();
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Faire le résumé avec l'IA" }))[0]!,
  );
  await waitFor(() => expect(controller).toBeDefined());
  controller!.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        type: "progress",
        progress: {
          stage: "content",
          status: "running",
          message: "Téléchargement de la page complète",
          at: "2026-10-06T12:00:00Z",
        },
      }) + "\n",
    ),
  );
  expect(await screen.findByText("Téléchargement de la page complète")).toBeInTheDocument();
  expect(screen.getByText("Contenu de l'article en cours")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Résumé en cours…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Récupérer à nouveau les articles" })).toBeDisabled();
  controller!.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result }) + "\n"));
  controller!.close();
  expect(await screen.findByText(result.summary.summary)).toBeInTheDocument();
  expect(screen.getByText("Test terminé")).toBeInTheDocument();
});
test("page or AI errors stay on the article and can be retried", async () => {
  failSummary = true;
  mount();
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Faire le résumé avec l'IA" }))[0]!,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Ollama inaccessible");
  failSummary = false;
  await userEvent.click(screen.getAllByRole("button", { name: "Faire le résumé avec l'IA" })[0]!);
  expect(await screen.findByText(result.summary.summary)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
test("allows collection retry and refreshing removes previous test results", async () => {
  failCollect = true;
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Source inaccessible");
  failCollect = false;
  await userEvent.click(screen.getByRole("button", { name: "Récupérer à nouveau les articles" }));
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Faire le résumé avec l'IA" }))[0]!,
  );
  expect(await screen.findByText(result.summary.summary)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Récupérer à nouveau les articles" }));
  expect(await screen.findByText("1. Article déjà livré")).toBeInTheDocument();
  expect(screen.queryByText(result.summary.summary)).not.toBeInTheDocument();
  expect(collectCalls).toBe(3);
});
