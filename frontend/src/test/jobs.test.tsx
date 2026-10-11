import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import type { ArticleJobSnapshot, CollectionRunSnapshot } from "@dailybrief/shared";

const active: CollectionRunSnapshot = {
  id: "current",
  trigger: "scheduled",
  state: "active",
  active: true,
  startedAt: "2026-10-10T07:30:00Z",
  finishedAt: null,
  total: 15,
  completed: 4,
  failed: 0,
  skipped: 1,
  events: [],
  result: null,
  error: null,
};
const failed: CollectionRunSnapshot = {
  ...active,
  id: "old",
  state: "failed",
  active: false,
  finishedAt: "2026-10-09T07:35:00Z",
  error: "Le modèle IA n'est pas installé.",
  completed: 15,
  failed: 15,
};
const row = (i: number): ArticleJobSnapshot => {
  const state =
    i === 3
      ? "failed"
      : i === 4
        ? "active"
        : i === 5
          ? "waiting"
          : i === 6
            ? "delayed"
            : "completed";
  return {
    id: `job-${i}`,
    articleId: `article-${i}`,
    title: `Article ${i}`,
    sourceUrl: "https://feed.example/rss",
    state,
    attempts: 1,
    skipped: i === 2,
    progress: null,
    error: i === 3 ? "Erreur IA sur cet article." : null,
    summary:
      i === 2 || state !== "completed"
        ? null
        : {
            title: `Titre résumé ${i}`,
            summary: `Résumé de l’article ${i}.\nAvec une seconde ligne.`,
            keyPoints: ["Premier point clé", "<img src=x onerror=alert(1)>"],
          },
  };
};
let articleJobs: ArticleJobSnapshot[];
function jobPage(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  const status = params.get("status") ?? "all";
  const filtered = articleJobs.filter((job) =>
    status === "all"
      ? true
      : status === "waiting"
        ? job.state === "waiting" || job.state === "delayed"
        : status === "skipped"
          ? job.skipped
          : status === "completed"
            ? job.state === "completed" && !job.skipped
            : job.state === status,
  );
  const page = Math.min(
    Number(params.get("page") ?? 1),
    Math.max(1, Math.ceil(filtered.length / 5)),
  );
  return {
    jobs: filtered.slice((page - 1) * 5, page * 5),
    total: filtered.length,
    page,
    pageSize: 5,
  };
}
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  articleJobs = Array.from({ length: 15 }, (_, i) => row(i + 1));
  fetchMock = vi.fn(async (url: string) => {
    const body = url.endsWith("/auth/me")
      ? { id: "u1", email: "reader@example.com" }
      : url.endsWith("/collection/current")
        ? active
        : url.endsWith("/collection/runs")
          ? [active, failed]
          : url.includes("/jobs?page=")
            ? jobPage(url)
            : url.endsWith("/collection/runs/current")
              ? active
              : url.endsWith("/collection/runs/old")
                ? failed
                : [];
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);
});
function mount(path = "/jobs") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
test("opens the collection requested from a Daily Brief and displays the reason for ignored articles", async () => {
  articleJobs[1]!.relevanceReason = "Hors des centres d’intérêt : faits divers.";
  mount("/jobs?run=old&status=skipped");
  expect(await screen.findByRole("cell", { name: "Ignoré" })).toBeInTheDocument();
  expect(
    screen.getByRole("cell", { name: "Hors des centres d’intérêt : faits divers." }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Récupération")).toHaveValue("old");
  expect(
    fetchMock.mock.calls.some(([url]) =>
      url.endsWith("/collection/runs/old/jobs?page=1&status=skipped"),
    ),
  ).toBe(true);
  expect(screen.getByLabelText("Récupération en cours", { exact: true })).toBeInTheDocument();
});
test("restores scheduled progress and shows five server-paginated articles at a time", async () => {
  const user = userEvent.setup();
  mount();
  expect(
    await screen.findByRole("heading", { name: "Historique d’exécutions" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Historique d’exécutions" })).toHaveAttribute(
    "href",
    "/jobs",
  );
  expect(await screen.findByRole("link", { name: "Voir l’historique" })).toHaveAttribute(
    "href",
    "/jobs",
  );
  expect(await screen.findByText("Article 1", { exact: true })).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(6);
  expect(screen.getByText("1–5 sur 15 articles")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "15");
  expect(screen.getByRole("button", { name: "Récupération en cours…" })).toBeDisabled();
  expect(screen.getByRole("cell", { name: "Ignoré" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "Erreur IA sur cet article." })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Résumé IA" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 3" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 4" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Page suivante" }));
  expect(await screen.findByText("Article 10", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("Article 1", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText("Page 2 sur 3")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Page suivante" }));
  expect(await screen.findByText("Article 15", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("Article 1", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page suivante" })).toBeDisabled();
  expect(screen.getByText("11–15 sur 15 articles")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/jobs?page=3&status=all"))).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/collection/run"))).toBe(false);
});
test("opens the saved AI summary and key points with the keyboard, renders plain text and restores focus", async () => {
  const user = userEvent.setup();
  mount();
  const trigger = await screen.findByRole("button", {
    name: "Voir le résumé de Article 1",
  });
  expect(screen.queryByText("Titre résumé 1")).not.toBeInTheDocument();
  const requestCount = fetchMock.mock.calls.length;
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", { name: "Résumé IA" });
  expect(dialog).toHaveAccessibleDescription("Article 1");
  expect(within(dialog).getByRole("heading", { name: "Titre résumé 1" })).toBeInTheDocument();
  expect(within(dialog).getByText("Résumé de l’article 1. Avec une seconde ligne.")).toHaveClass(
    "whitespace-pre-line",
  );
  expect(within(dialog).getByText("Premier point clé")).toBeInTheDocument();
  expect(within(dialog).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(within(dialog).queryByRole("img")).toBeNull();
  expect(fetchMock.mock.calls.length).toBe(requestCount);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});
test("selects a previous failed collection and preserves the active global banner", async () => {
  const user = userEvent.setup();
  mount();
  await user.selectOptions(await screen.findByLabelText("Récupération"), "old");
  expect(await screen.findByRole("alert")).toHaveTextContent("Le modèle IA n'est pas installé.");
  expect(screen.getByLabelText("Récupération en cours", { exact: true })).toBeInTheDocument();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.endsWith("/collection/runs/old/jobs?page=1&status=all"),
      ),
    ).toBe(true),
  );
});
test("makes the saved summary available as soon as the article finishes, without reloading", async () => {
  let finished = false;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/jobs?page=")) {
      const job = row(1);
      return new Response(
        JSON.stringify({
          jobs: [
            {
              ...job,
              state: finished ? "completed" : "active",
              summary: finished ? job.summary : null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 5,
        }),
      );
    }
    return original(url);
  });
  mount();
  await screen.findByText("Article 1", { exact: true });
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 1" })).toBeNull();
  finished = true;
  expect(
    await screen.findByRole("button", { name: "Voir le résumé de Article 1" }, { timeout: 3000 }),
  ).toBeInTheDocument();
});
test("sends bookmarked status and page to the backend, resets pages on filtering and keeps global progress", async () => {
  const user = userEvent.setup();
  mount("/jobs?status=completed&page=2");
  await screen.findByText("Article 15", { exact: true });
  expect(screen.getByRole("combobox", { name: "Statut des articles" })).toHaveValue("completed");
  expect(screen.getByText("6–10 sur 10 articles")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/jobs?page=2&status=completed"))).toBe(
    true,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Statut des articles" }),
    "waiting",
  );
  await screen.findByText("Article 5", { exact: true });
  expect(screen.getByText("Article 6", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("1–2 sur 2 articles")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page suivante" })).toBeDisabled();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "15");
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/jobs?page=1&status=waiting"))).toBe(
    true,
  );
  await user.selectOptions(screen.getByRole("combobox", { name: "Statut des articles" }), "active");
  await screen.findByText("Article 4", { exact: true });
  expect(screen.getByText("1–1 sur 1 article")).toBeInTheDocument();
  await user.selectOptions(screen.getByRole("combobox", { name: "Statut des articles" }), "failed");
  await screen.findByText("Article 3", { exact: true });
  expect(screen.getByRole("cell", { name: "Erreur IA sur cet article." })).toBeInTheDocument();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Statut des articles" }),
    "skipped",
  );
  await screen.findByText("Article 2", { exact: true });
  expect(screen.getByRole("cell", { name: "Ignoré" })).toBeInTheDocument();
  await user.selectOptions(screen.getByRole("combobox", { name: "Statut des articles" }), "all");
  await screen.findByText("Article 1", { exact: true });
  expect(screen.getByText("Page 1 sur 3")).toBeInTheDocument();
});
test("uses the backend's corrected page when the last filtered page disappears during a live collection", async () => {
  mount("/jobs?status=completed&page=2");
  await screen.findByText("Article 15", { exact: true });
  articleJobs = articleJobs.filter((job) => Number(job.articleId.split("-")[1]) <= 9);
  await screen.findByText("Article 1", { exact: true }, { timeout: 3000 });
  expect(screen.getByText("1–4 sur 4 articles")).toBeInTheDocument();
  expect(screen.getByText("Page 1 sur 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page suivante" })).toBeDisabled();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => url.endsWith("/jobs?page=1&status=completed")),
    ).toBe(true),
  );
});
test("ignores an obsolete filtered response and retries an error without losing the selected status", async () => {
  const user = userEvent.setup();
  const original = fetchMock.getMockImplementation()!;
  let resolveOld!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  let failActive = true;
  fetchMock.mockImplementation(async (url, init) => {
    if (url.includes("/jobs?") && url.endsWith("status=completed")) {
      oldSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    }
    if (url.includes("/jobs?") && url.endsWith("status=active") && failActive)
      return new Response(JSON.stringify({ message: "Historique indisponible" }), { status: 503 });
    return original(url, init);
  });
  mount();
  await screen.findByText("Article 1", { exact: true });
  const filter = screen.getByRole("combobox", { name: "Statut des articles" });
  await user.selectOptions(filter, "completed");
  await waitFor(() => expect(resolveOld).toBeDefined());
  await user.selectOptions(filter, "active");
  expect(oldSignal?.aborted).toBe(true);
  expect(await screen.findByRole("alert")).toHaveTextContent("Historique indisponible");
  failActive = false;
  await user.click(screen.getByRole("button", { name: "Réessayer" }));
  await screen.findByText("Article 4", { exact: true });
  await act(async () => {
    resolveOld(new Response(JSON.stringify(jobPage("/api/jobs?page=1&status=completed"))));
  });
  expect(screen.queryByText("Article 1", { exact: true })).toBeNull();
  expect(filter).toHaveValue("active");
  expect(screen.getByText("1–1 sur 1 article")).toBeInTheDocument();
});
