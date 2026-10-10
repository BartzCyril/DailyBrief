import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Dashboard } from "@dailybrief/shared";
import { App } from "../App";
import { emptyDashboard } from "./fixtures";
let data: Dashboard;
let failLoad = false;
let failRun = false;
function mockApi() {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ id: "u1", email: "reader@example.com" }));
    if (url.endsWith("/journals"))
      return new Response(
        JSON.stringify({ journals: [], lastInventoriedAt: null, unresolvedCount: 0 }),
      );
    if (url.endsWith("/dashboard"))
      return new Response(JSON.stringify(failLoad ? { message: "Dashboard indisponible" } : data), {
        status: failLoad ? 503 : 200,
      });
    if (url.endsWith("/sources")) return new Response("[]");
    if (url.endsWith("/settings/dailybrief")) {
      const body = JSON.parse(String(init?.body));
      data.collection = {
        ...data.collection,
        enabled: body.collectionEnabled,
        time: body.collectionTime,
        timezone: body.timezone,
        nextRunAt: body.collectionEnabled ? "2026-10-07T05:30:00Z" : null,
      };
      return new Response("{}");
    }
    if (url.endsWith("/collection/run")) {
      data.collection.lastRunAt = "2026-10-06T06:00:00Z";
      return new Response(JSON.stringify({ status: failRun ? "FAILED" : "NO_NEW_ARTICLES" }));
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
function mount() {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <App />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  data = structuredClone(emptyDashboard);
  failLoad = false;
  failRun = false;
  mockApi();
});
test("shows statistics and links to separate sources and journals pages", async () => {
  data.sources = { total: 6, rss: 4, scraping: 2, enabled: 5 };
  mount();
  await screen.findByText("Sources totales");
  for (const [label, count] of [
    ["Sources totales", "6"],
    ["Flux RSS", "4"],
    ["Sources scraping", "2"],
    ["Sources actives", "5"],
  ])
    expect(screen.getByText(label!).closest('[data-slot="card"]')).toHaveTextContent(count!);
  expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/sources");
  expect(screen.getByRole("link", { name: "Journaux" })).toHaveAttribute("href", "/journals");
  expect(screen.getByRole("link", { name: "Tableau de bord" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByRole("heading", { name: "Vos journaux" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Ajouter un journal" })).not.toBeInTheDocument();
});
test("saves activation, time and timezone in one explicit action", async () => {
  const mock = mockApi();
  mount();
  const ui = userEvent.setup();
  await ui.click(await screen.findByRole("switch", { name: "Récupération automatique" }));
  const time = screen.getByLabelText("Heure quotidienne");
  await ui.clear(time);
  await ui.type(time, "08:45");
  const timezone = screen.getByLabelText("Fuseau horaire");
  await ui.clear(timezone);
  await ui.type(timezone, "America/New_York");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  expect(await screen.findByText("Réglages enregistrés.")).toBeInTheDocument();
  const call = mock.mock.calls.find((call) => call[0].endsWith("/settings/dailybrief"));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    collectionEnabled: true,
    collectionTime: "08:45",
    timezone: "America/New_York",
  });
});
test("disables automatic collection and shows no planned run", async () => {
  data.collection.enabled = true;
  data.collection.nextRunAt = "2026-10-07T05:30:00Z";
  mount();
  await userEvent.click(await screen.findByRole("switch", { name: "Récupération automatique" }));
  await userEvent.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  await screen.findByText("Réglages enregistrés.");
  expect(screen.getByText("Non planifiée")).toBeInTheDocument();
});
test("displays backend collection dates in the saved timezone", async () => {
  data.collection = {
    ...data.collection,
    enabled: true,
    lastRunAt: "2026-10-06T05:30:00Z",
    nextRunAt: "2026-10-07T05:30:00Z",
  };
  mount();
  expect(await screen.findByText(/6 oct. 2026, 07:30/)).toBeInTheDocument();
  expect(screen.getByText(/7 oct. 2026, 07:30/)).toBeInTheDocument();
});
test("runs a manual collection and refreshes dashboard information", async () => {
  const mock = mockApi();
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Récupérer maintenant" }));
  expect(await screen.findByText("Aucun nouvel article à envoyer.")).toBeInTheDocument();
  expect(mock).toHaveBeenCalledWith(
    "/api/collection/run",
    expect.objectContaining({ method: "POST", body: "{}", credentials: "include" }),
  );
  expect(await screen.findByText(/6 oct. 2026, 08:00/)).toBeInTheDocument();
});
test("keeps manual collection disabled while a run is pending", async () => {
  const normal = mockApi();
  let resolve: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/collection/run")
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : normal(url, init),
    ),
  );
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Récupérer maintenant" }));
  expect(screen.getByRole("button", { name: "Collecte en cours…" })).toBeDisabled();
  resolve(new Response(JSON.stringify({ status: "SENT" })));
  expect(await screen.findByText("Votre newsletter a été envoyée.")).toBeInTheDocument();
});
test("reports failed pipeline results and loading errors", async () => {
  failRun = true;
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Récupérer maintenant" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("n'a pas pu aboutir");
});
test("shows live article progress before completion and displays the precise AI error", async () => {
  const normal = mockApi();
  let controller!: ReadableStreamDefaultController;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/collection/run")
        ? Promise.resolve(
            new Response(
              new ReadableStream({
                start(c) {
                  controller = c;
                },
              }),
              { headers: { "Content-Type": "application/x-ndjson" } },
            ),
          )
        : normal(url, init),
    ),
  );
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Récupérer maintenant" }));
  const message = "Envoi à l'IA : Article de la bibliothèque";
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        type: "progress",
        progress: {
          stage: "ai",
          status: "running",
          message,
          at: "2026-10-06T08:00:00Z",
          completed: 0,
          total: 10,
        },
      }) + "\n",
    ),
  );
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getByText("Résumé IA en cours · 0/10")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collecte en cours…" })).toBeDisabled();
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        type: "result",
        result: {
          status: "FAILED",
          failure: {
            stage: "ai",
            code: "MODEL_MISSING",
            message: "Le modèle IA qwen3:4b n'est pas installé.",
          },
        },
      }) + "\n",
    ),
  );
  controller.close();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Le modèle IA qwen3:4b n'est pas installé.",
  );
  expect(screen.getByRole("log", { name: "Étapes de la collecte" })).toHaveTextContent(message);
  expect(screen.getByRole("button", { name: "Récupérer maintenant" })).toBeEnabled();
});
test("can retry initial dashboard errors", async () => {
  failLoad = true;
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard indisponible");
  failLoad = false;
  await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  expect(await screen.findByText("Sources totales")).toBeInTheDocument();
});
test("validates unknown timezones before saving", async () => {
  const mock = mockApi();
  mount();
  const ui = userEvent.setup();
  const timezone = await screen.findByLabelText("Fuseau horaire");
  await ui.clear(timezone);
  await ui.type(timezone, "Unknown/Zone");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("fuseau horaire");
  expect(mock.mock.calls.some((call) => call[0].endsWith("/settings/dailybrief"))).toBe(false);
});

test("navigates between sources and journals without loading unrelated features", async () => {
  const mock = mockApi();
  const user = userEvent.setup();
  mount();
  await screen.findByText("Sources totales");
  expect(
    mock.mock.calls.some(([url]) => url.endsWith("/sources") || url.endsWith("/journals")),
  ).toBe(false);
  await user.click(screen.getByRole("link", { name: "Sources" }));
  expect(await screen.findByText(/Aucune source configurée/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Sources", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Ajouter un flux RSS" })).toHaveAttribute(
    "href",
    "/sources/new/rss",
  );
  expect(mock.mock.calls.some(([url]) => url.endsWith("/journals"))).toBe(false);
  await user.click(screen.getByRole("link", { name: "Journaux" }));
  expect(await screen.findByRole("heading", { name: "Vos journaux" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ajouter un journal" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Ajouter un flux RSS" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Journaux" })).toHaveAttribute("aria-current", "page");
});
