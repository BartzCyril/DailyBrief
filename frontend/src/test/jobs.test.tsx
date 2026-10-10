import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
let fetchMock: ReturnType<typeof vi.fn>;
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
  expect(await screen.findByRole("heading", { name: "Jobs de récupération" })).toBeInTheDocument();
  expect(await screen.findByText("Article 1", { exact: true })).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "15");
  expect(screen.getByRole("button", { name: "Récupération en cours…" })).toBeDisabled();
  expect(screen.getByRole("cell", { name: "Ignoré" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "Erreur IA sur cet article." })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Suivante" }));
  expect(await screen.findByText("Article 15", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("Article 1", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Suivante" })).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/collection/run"))).toBe(false);
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
