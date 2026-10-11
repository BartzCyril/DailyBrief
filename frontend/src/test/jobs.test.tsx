import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
const row = (i: number): ArticleJobSnapshot => ({
  id: `job-${i}`,
  articleId: `article-${i}`,
  title: `Article ${i}`,
  sourceUrl: "https://feed.example/rss",
  state: i === 3 ? "failed" : i === 4 ? "active" : "completed",
  attempts: 1,
  skipped: i === 2,
  progress: null,
  error: i === 3 ? "Erreur IA sur cet article." : null,
  summary:
    i === 2 || i === 3 || i === 4
      ? null
      : {
          title: `Titre résumé ${i}`,
          summary: `Résumé de l’article ${i}.\nAvec une seconde ligne.`,
          keyPoints: ["Premier point clé", "<img src=x onerror=alert(1)>"],
        },
});
let fetchMock: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const body = url.endsWith("/auth/me")
      ? { id: "u1", email: "reader@example.com" }
      : url.endsWith("/collection/current")
        ? active
        : url.endsWith("/collection/runs")
          ? [active, failed]
          : url.includes("/jobs?page=")
            ? {
                jobs: Array.from({ length: url.endsWith("page=2") ? 5 : 10 }, (_, i) =>
                  row(i + (url.endsWith("page=2") ? 11 : 1)),
                ),
                total: 15,
                page: url.endsWith("page=2") ? 2 : 1,
                pageSize: 10,
              }
            : url.endsWith("/collection/runs/current")
              ? active
              : url.endsWith("/collection/runs/old")
                ? failed
                : [];
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);
});
function mount() {
  render(
    <MemoryRouter initialEntries={["/jobs"]}>
      <App />
    </MemoryRouter>,
  );
}
test("restores scheduled progress, lists own jobs and paginates ten at a time", async () => {
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
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "15");
  expect(screen.getByRole("button", { name: "Récupération en cours…" })).toBeDisabled();
  expect(screen.getByRole("cell", { name: "Ignoré" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "Erreur IA sur cet article." })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Résumé IA" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 3" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Voir le résumé de Article 4" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Suivante" }));
  expect(await screen.findByText("Article 15", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("Article 1", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Suivante" })).toBeDisabled();
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
      fetchMock.mock.calls.some(([url]) => url.endsWith("/collection/runs/old/jobs?page=1")),
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
          pageSize: 10,
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
