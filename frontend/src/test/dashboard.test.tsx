import { test, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Dashboard, CollectionRunSnapshot, RunResult } from "@dailybrief/shared";
import { App } from "../App";
import { emptyDashboard } from "./fixtures";
const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
function detectTimezone(timezone = "Europe/Paris") {
  return vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...resolvedOptions.call(this), timeZone: timezone };
  });
}
let data: Dashboard;
let failLoad = false;
let failRun = false;
let currentRun: CollectionRunSnapshot | null = null;
const completedRun = (status: RunResult["status"]): CollectionRunSnapshot => ({
  id: "run-1",
  trigger: "manual",
  state: status === "FAILED" ? "failed" : "completed",
  active: false,
  startedAt: "2026-10-06T08:00:00Z",
  finishedAt: "2026-10-06T08:01:00Z",
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  events: [],
  error: null,
  result: {
    status,
    sourcesProcessed: 0,
    sourcesFailed: 0,
    articlesCollected: 0,
    newArticles: 0,
    articlesSummarized: 0,
    emailSent: status === "SENT",
  },
});
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
    if (url.endsWith("/collection/current")) return new Response(JSON.stringify(currentRun));
    if (new URL(url, "http://localhost").pathname === "/api/sources")
      return new Response(JSON.stringify({ sources: [], total: 0, page: 1, pageSize: 5 }));
    if (url.endsWith("/settings/dailybrief")) {
      const body = JSON.parse(String(init?.body));
      data.collection = {
        ...data.collection,
        enabled: body.collectionEnabled ?? data.collection.enabled,
        time: body.collectionTime ?? data.collection.time,
        timezone: body.timezone ?? data.collection.timezone,
        nextRunAt:
          (body.collectionEnabled ?? data.collection.enabled) ? "2026-10-07T05:30:00Z" : null,
      };
      return new Response("{}");
    }
    if (url.endsWith("/collection/run")) {
      data.collection.lastRunAt = "2026-10-06T06:00:00Z";
      currentRun = completedRun(failRun ? "FAILED" : "NO_NEW_ARTICLES");
      return new Response(JSON.stringify(currentRun), { status: 202 });
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
  detectTimezone();
  data = structuredClone(emptyDashboard);
  data.collection.timezone = "Europe/Paris";
  failLoad = false;
  failRun = false;
  currentRun = null;
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
test("only enables saving when collection settings differ from their saved values", async () => {
  const mock = mockApi();
  mount();
  const ui = userEvent.setup();
  const save = await screen.findByRole("button", { name: "Enregistrer les réglages" });
  const toggle = screen.getByRole("switch", { name: "Récupération automatique" });
  expect(toggle).toHaveClass("cursor-pointer");
  expect(save).toBeDisabled();
  fireEvent.submit(save.closest("form")!);
  expect(mock.mock.calls.some(([url]) => url.endsWith("/settings/dailybrief"))).toBe(false);
  await ui.click(toggle);
  expect(save).toBeEnabled();
  await ui.click(toggle);
  expect(save).toBeDisabled();
  const time = screen.getByLabelText("Heure quotidienne");
  fireEvent.change(time, { target: { value: "08:45" } });
  expect(save).toBeEnabled();
  fireEvent.change(time, { target: { value: "07:30" } });
  expect(save).toBeDisabled();
  expect(screen.queryByLabelText("Fuseau horaire")).toBeNull();
});
test("saves activation and local time with the automatically detected timezone", async () => {
  detectTimezone("America/New_York");
  data.collection.timezone = "America/New_York";
  const mock = mockApi();
  mount();
  const ui = userEvent.setup();
  await ui.click(await screen.findByRole("switch", { name: "Récupération automatique" }));
  const time = screen.getByLabelText("Heure quotidienne");
  await ui.clear(time);
  await ui.type(time, "08:45");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  expect(await screen.findByText("Réglages enregistrés.")).toBeInTheDocument();
  const call = mock.mock.calls.find((call) => call[0].endsWith("/settings/dailybrief"));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    collectionEnabled: true,
    collectionTime: "08:45",
    timezone: "America/New_York",
  });
  const save = screen.getByRole("button", { name: "Enregistrer les réglages" });
  expect(save).toBeDisabled();
  await ui.click(screen.getByRole("switch", { name: "Récupération automatique" }));
  expect(save).toBeEnabled();
  await ui.click(screen.getByRole("switch", { name: "Récupération automatique" }));
  expect(save).toBeDisabled();
});
test("prevents duplicate settings saves and preserves changes after a failed save", async () => {
  const normal = mockApi();
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/settings/dailybrief")
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : normal(url, init),
    ),
  );
  mount();
  const ui = userEvent.setup();
  const toggle = await screen.findByRole("switch", { name: "Récupération automatique" });
  await ui.click(toggle);
  await ui.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  expect(screen.getByRole("button", { name: "Enregistrement…" })).toBeDisabled();
  expect(toggle).toBeDisabled();
  resolve(
    new Response(JSON.stringify({ message: "Enregistrement indisponible" }), { status: 503 }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Enregistrement indisponible");
  expect(toggle).toBeChecked();
  expect(screen.getByRole("button", { name: "Enregistrer les réglages" })).toBeEnabled();
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
test("displays backend collection dates in the detected browser timezone", async () => {
  data.collection = {
    ...data.collection,
    enabled: true,
    timezone: "America/New_York",
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
  currentRun = completedRun("SENT");
  resolve(new Response(JSON.stringify(currentRun)));
  expect(await screen.findByText("Votre newsletter a été envoyée.")).toBeInTheDocument();
});
test("reports failed pipeline results and loading errors", async () => {
  failRun = true;
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Récupérer maintenant" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("n'a pas pu aboutir");
});
test("restores a running collection after reload and updates its progress independently of the original request", async () => {
  const message = "Envoi à l'IA : Article de la bibliothèque";
  currentRun = {
    ...completedRun("NO_NEW_ARTICLES"),
    state: "active",
    active: true,
    result: null,
    finishedAt: null,
    total: 15,
    completed: 4,
    events: [{ stage: "ai", status: "running", message, at: "2026-10-06T08:00:00Z" }],
  };
  const mock = mockApi();
  mount();
  expect(await screen.findByText("Récupération en cours")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Articles traités" })).toHaveAttribute(
    "aria-valuenow",
    "4",
  );
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "15");
  expect(screen.getByRole("button", { name: "Collecte en cours…" })).toBeDisabled();
  expect(mock.mock.calls.some(([url]) => url.endsWith("/collection/run"))).toBe(false);
  expect(await screen.findByText(message)).toBeInTheDocument();
  currentRun = {
    ...completedRun("FAILED"),
    total: 15,
    completed: 15,
    failed: 1,
    events: currentRun.events,
    result: {
      ...completedRun("FAILED").result!,
      failure: {
        stage: "ai",
        code: "MODEL_MISSING",
        message: "Le modèle IA qwen3:4b n'est pas installé.",
      },
    },
  };
  window.dispatchEvent(new Event("focus"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Le modèle IA qwen3:4b n'est pas installé.",
  );
  expect(screen.queryByText("Récupération en cours")).not.toBeInTheDocument();
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
test.each(["America/New_York", "UTC"])(
  "automatically persists the browser timezone %s without changing activation or local time",
  async (timezone) => {
    detectTimezone(timezone);
    data.collection.enabled = true;
    const mock = mockApi();
    mount();
    const save = await screen.findByRole("button", { name: "Enregistrer les réglages" });
    expect(screen.queryByLabelText("Fuseau horaire")).toBeNull();
    const writes = mock.mock.calls.filter(([url]) => url.endsWith("/settings/dailybrief"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ timezone });
    expect(data.collection).toMatchObject({
      enabled: true,
      time: "07:30",
      timezone,
    });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Récupérer maintenant" }));
    await screen.findByText("Aucun nouvel article à envoyer.");
    expect(mock.mock.calls.filter(([url]) => url.endsWith("/settings/dailybrief"))).toHaveLength(1);
  },
);

test.each(["", "Unknown/Zone"])(
  "preserves the saved timezone if browser detection returns %j",
  async (zone) => {
    detectTimezone(zone);
    const mock = mockApi();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Récupération automatique" }));
    expect(mock.mock.calls.some((call) => call[0].endsWith("/settings/dailybrief"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
    await screen.findByText("Réglages enregistrés.");
    expect(data.collection.timezone).toBe("Europe/Paris");
  },
);

test("shows a synchronization failure and retries without treating it as a settings edit", async () => {
  detectTimezone("America/New_York");
  const normal = mockApi();
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      fail && url.endsWith("/settings/dailybrief")
        ? Promise.resolve(
            new Response(JSON.stringify({ message: "Synchronisation indisponible" }), {
              status: 503,
            }),
          )
        : normal(url, init),
    ),
  );
  mount();
  await screen.findByText("Synchronisation indisponible");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  expect(await screen.findByRole("button", { name: "Enregistrer les réglages" })).toBeDisabled();
  expect(data.collection.timezone).toBe("America/New_York");
});

test("navigates between sources and journals without loading unrelated features", async () => {
  const mock = mockApi();
  const user = userEvent.setup();
  mount();
  await screen.findByText("Sources totales");
  expect(
    mock.mock.calls.some(
      ([url]) =>
        new URL(url, "http://localhost").pathname === "/api/sources" || url.endsWith("/journals"),
    ),
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
  expect(await screen.findByRole("heading", { name: "Journaux", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ajouter un journal" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Ajouter un flux RSS" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Journaux" })).toHaveAttribute("aria-current", "page");
});
