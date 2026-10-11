import { expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefArticlesDialog } from "../dashboard/BriefArticlesDialog";

const article = (index: number) => ({
  id: `a-${index}`,
  title: `Article ${index}`,
  url: `https://journal.example/articles/${index}`,
  summary: `Résumé ${index}.\nUne deuxième ligne.`,
  keyPoints: ["Un point essentiel", "<img src=x onerror=alert(1)>"],
  publishedAt: "2026-10-10T08:00:00Z",
});
const articlePage = (page = 1) => ({
  articles: page === 1 ? [1, 2, 3, 4, 5].map(article) : [article(6)],
  total: 6,
  page,
  pageSize: 5,
});
function mount() {
  render(<BriefArticlesDialog briefId="brief-1" timezone="Europe/Paris" />);
}

test("loads five edition articles per backend page, opens the dialog with the keyboard and restores focus", async () => {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          articlePage(Number(new URL(url, "http://localhost").searchParams.get("page"))),
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  mount();
  expect(fetcher).not.toHaveBeenCalled();
  const trigger = screen.getByRole("button", { name: "Lire les résumés individuels" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", { name: "Résumés individuels" });
  expect(await within(dialog).findByRole("heading", { name: "Article 1" })).toBeInTheDocument();
  expect(within(dialog).getAllByRole("heading", { level: 3 })).toHaveLength(5);
  expect(within(dialog).getByText("1–5 sur 6 articles")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Article 6" })).toBeNull();
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/dailybrief/brief-1/articles?page=1");
  const summary = within(dialog).getAllByText("Lire le résumé", {
    selector: "summary",
    exact: false,
  })[0]!;
  await user.click(summary);
  expect(summary.closest("details")).toHaveAttribute("open");
  const first = screen.getByRole("heading", { name: "Article 1" }).closest("li")!;
  expect(within(first).getByText("Résumé 1. Une deuxième ligne.")).toHaveClass(
    "whitespace-pre-line",
  );
  expect(within(first).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(within(first).queryByRole("img")).toBeNull();
  expect(within(first).getByRole("link", { name: "Lire l’article original" })).toHaveAttribute(
    "href",
    "https://journal.example/articles/1",
  );
  await user.click(screen.getByRole("button", { name: "Page suivante des résumés" }));
  expect(await screen.findByRole("heading", { name: "Article 6" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Article 1" })).toBeNull();
  expect(screen.getByText("6–6 sur 6 articles")).toBeInTheDocument();
  expect(fetcher.mock.calls[1]?.[0]).toBe("/api/dailybrief/brief-1/articles?page=2");
  expect(screen.getByRole("button", { name: "Page suivante des résumés" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(await screen.findByRole("heading", { name: "Article 1" })).toBeInTheDocument();
  expect(screen.getByText("Page 1 sur 2")).toBeInTheDocument();
  expect(fetcher.mock.calls[2]?.[0]).toBe("/api/dailybrief/brief-1/articles?page=1");
});

test("reports a load error and retries the same page without closing the modal", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Résumés indisponibles." }), { status: 503 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(articlePage())));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole("button", { name: "Lire les résumés individuels" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Résumés indisponibles.");
  await user.click(screen.getByRole("button", { name: "Réessayer" }));
  expect(await screen.findByRole("heading", { name: "Article 1" })).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/dailybrief/brief-1/articles?page=1",
    "/api/dailybrief/brief-1/articles?page=1",
  ]);
});

test("allows closing a pending request and aborts its response", async () => {
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole("button", { name: "Lire les résumés individuels" }));
  expect(screen.getByRole("status")).toHaveTextContent("Chargement des résumés…");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(signal?.aborted).toBe(true);
});

test("shows an empty edition article list and omits unsafe original URLs", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ articles: [], total: 0, page: 1, pageSize: 5 })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          articles: [{ ...article(1), url: "javascript:alert(1)" }],
          total: 1,
          page: 1,
          pageSize: 5,
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole("button", { name: "Lire les résumés individuels" }));
  expect(
    await screen.findByText("Aucun résumé disponible pour cette édition."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page suivante des résumés" })).toBeDisabled();
  await user.keyboard("{Escape}");
  fireEvent.click(screen.getByRole("button", { name: "Lire les résumés individuels" }));
  expect(await screen.findByRole("heading", { name: "Article 1" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Lire l’article original" })).toBeNull();
});
