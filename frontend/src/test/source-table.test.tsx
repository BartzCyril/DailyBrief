import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Source } from "@dailybrief/shared";
import { App } from "../App";
import { sourcePageFixture } from "./fixtures";

let sources: Source[];
beforeEach(() => {
  sources = [
    ...Array.from({ length: 11 }, (_, index): Source => ({
      id: `rss-${index + 1}`,
      type: "RSS",
      url: `https://news.example/feeds/${index + 1}`,
      enabled: index % 2 === 0,
      scrapingConfig: null,
    })),
    {
      id: "scraping-1",
      type: "SCRAPING",
      url: "https://scraping.example/news",
      enabled: true,
      scrapingConfig: {
        articleSelector: "article",
        titleSelector: "h2",
        linkSelector: "a",
        mode: "SCROLL",
      },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me"))
        return new Response(JSON.stringify({ id: "u1", email: "reader@example.com" }));
      if (init?.method === "PATCH") {
        sources = sources.map((source) =>
          url.endsWith(`/${source.id}`) ? { ...source, ...JSON.parse(String(init.body)) } : source,
        );
        return new Response(null, { status: 204 });
      }
      if (init?.method === "DELETE") {
        sources = sources.filter((source) => !url.endsWith(`/${source.id}`));
        return new Response(null, { status: 204 });
      }
      if (new URL(url, "http://localhost").pathname === "/api/sources")
        return new Response(JSON.stringify(sourcePageFixture(sources, url)));
      return new Response("null");
    }),
  );
});
function mount(path = "/sources") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
function urlLinks() {
  return within(screen.getByRole("table")).queryAllByRole("link", { name: /^https:\/\// });
}

test("separates RSS and scraping, changes the add link and supports keyboard tabs", async () => {
  mount();
  const ui = userEvent.setup();
  await screen.findByRole("table");
  expect(screen.getByRole("tab", { name: "RSS" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("link", { name: "Ajouter un flux RSS" })).toHaveAttribute(
    "href",
    "/sources/new/rss",
  );
  expect(
    screen.queryByRole("link", { name: "Ajouter une source de scraping" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Ajoutez et configurez les flux RSS/)).not.toBeInTheDocument();
  screen.getByRole("tab", { name: "RSS" }).focus();
  await ui.keyboard("{ArrowRight}");
  expect(await screen.findByRole("tab", { name: "SCRAPING", selected: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("link", { name: "Ajouter une source de scraping" })).toHaveAttribute(
    "href",
    "/sources/new/scraping",
  );
  await waitFor(() => expect(urlLinks()).toHaveLength(1));
  expect(urlLinks()[0]).toHaveAttribute("href", "https://scraping.example/news");
  await ui.keyboard("{ArrowLeft}");
  await screen.findByRole("tab", { name: "RSS", selected: true });
  await waitFor(() => expect(urlLinks()).toHaveLength(5));
});

test("opens a direct scraping tab link with safe external URL links", async () => {
  mount("/sources?type=scraping");
  const link = await screen.findByRole("link", { name: "https://scraping.example/news" });
  expect(screen.getByRole("tab", { name: "SCRAPING" })).toHaveAttribute("aria-selected", "true");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(within(link.closest("tr")!).getByRole("img", { name: "Active" })).toBeInTheDocument();
});

test("paginates at five sources and combines case-insensitive URL search and status filters", async () => {
  mount();
  const ui = userEvent.setup();
  await screen.findByRole("table");
  expect(urlLinks()).toHaveLength(5);
  expect(screen.getByText("1–5 sur 11 sources")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Page précédente" })).toBeDisabled();
  await ui.click(screen.getByRole("button", { name: "Page suivante" }));
  await screen.findByText("Page 2 sur 3");
  expect(urlLinks()).toHaveLength(5);
  expect(screen.getByText("Page 2 sur 3")).toBeInTheDocument();
  await ui.click(screen.getByRole("button", { name: "Page suivante" }));
  await waitFor(() => expect(urlLinks()).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Page suivante" })).toBeDisabled();
  await ui.click(screen.getByRole("searchbox", { name: "Rechercher une URL" }));
  await ui.paste("  NEWS.EXAMPLE/feeds/1  ");
  await waitFor(() => expect(urlLinks()).toHaveLength(3));
  expect(screen.getByText("Page 1 sur 1")).toBeInTheDocument();
  await ui.selectOptions(screen.getByRole("combobox", { name: "Statut des sources" }), "active");
  await waitFor(() =>
    expect(urlLinks().map((link) => link.getAttribute("href"))).toEqual([
      "https://news.example/feeds/1",
      "https://news.example/feeds/11",
    ]),
  );
  await ui.selectOptions(screen.getByRole("combobox", { name: "Statut des sources" }), "inactive");
  await waitFor(() => expect(urlLinks()).toHaveLength(1));
  expect(screen.getByRole("img", { name: "Inactive" })).toBeInTheDocument();
  await ui.clear(screen.getByRole("searchbox", { name: "Rechercher une URL" }));
  await ui.paste("no-match");
  expect(await screen.findByText(/Aucune source ne correspond/)).toBeInTheDocument();
  expect(urlLinks()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Page suivante" })).toBeDisabled();
});

test("keeps icon-only workflow actions accessible with a real hover tooltip", async () => {
  mount("/sources?type=scraping");
  const ui = userEvent.setup();
  const workflow = await screen.findByRole("link", { name: "Tester le workflow de A à Z" });
  expect(workflow).toHaveAttribute("href", "/sources/scraping-1/workflow");
  expect(workflow.textContent).toBe("");
  await ui.hover(workflow);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Tester le workflow de A à Z");
  await ui.unhover(workflow);
});

test("moves to the previous page when the last source is deleted with confirmation", async () => {
  mount();
  const ui = userEvent.setup();
  await screen.findByRole("table");
  await ui.click(screen.getByRole("button", { name: "Page suivante" }));
  await screen.findByText("Page 2 sur 3");
  await ui.click(screen.getByRole("button", { name: "Page suivante" }));
  await screen.findByText("Page 3 sur 3");
  await ui.click(screen.getByRole("button", { name: "Supprimer https://news.example/feeds/11" }));
  expect(sources.filter((source) => source.type === "RSS")).toHaveLength(11);
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "Êtes-vous sûr de vouloir supprimer ce flux RSS ?",
  );
  await ui.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }),
  );
  await screen.findByText("Source supprimée.");
  expect(screen.getByText("Page 2 sur 2")).toBeInTheDocument();
  expect(urlLinks()).toHaveLength(5);
  expect(urlLinks()[0]).toHaveAttribute("href", "https://news.example/feeds/6");
});

test("refreshes the active filter and pagination after disabling a source", async () => {
  mount();
  const ui = userEvent.setup();
  await screen.findByRole("table");
  await ui.selectOptions(screen.getByRole("combobox", { name: "Statut des sources" }), "active");
  await screen.findByText("1–5 sur 6 sources");
  await ui.click(screen.getByRole("button", { name: "Page suivante" }));
  await screen.findByText("Page 2 sur 2");
  await ui.click(screen.getByRole("switch", { name: "Activer https://news.example/feeds/11" }));
  await screen.findByText("Page 1 sur 1");
  expect(urlLinks()).toHaveLength(5);
  expect(
    screen.queryByRole("link", { name: "https://news.example/feeds/11" }),
  ).not.toBeInTheDocument();
  expect(sources.find((source) => source.id === "rss-11")?.enabled).toBe(false);
});

test("sends bookmarked type, search, status and page to the API and uses the returned total", async () => {
  mount("/sources?status=active&q=NEWS.EXAMPLE&page=2");
  await screen.findByText("Page 2 sur 2");
  expect(urlLinks()).toHaveLength(1);
  expect(screen.getByText("6–6 sur 6 sources")).toBeInTheDocument();
  const requests = vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).startsWith("/api/sources?"));
  expect(requests).toHaveLength(1);
  const params = new URL(String(requests[0]![0]), "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toEqual({
    type: "RSS",
    status: "active",
    q: "NEWS.EXAMPLE",
    page: "2",
  });
  await userEvent.click(screen.getByRole("button", { name: "Page précédente" }));
  await screen.findByText("1–5 sur 6 sources");
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("q=NEWS.EXAMPLE&page=1")),
  ).toBe(true);
});

test("renders the server page directly without filtering its rows or deriving the total locally", async () => {
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sources?"))
        return Promise.resolve(
          new Response(JSON.stringify({ sources: [sources[1]], total: 42, page: 3, pageSize: 5 })),
        );
      return original(url, init);
    }),
  );
  mount("/sources?status=active&q=server-query&page=3");
  await screen.findByText("Page 3 sur 9");
  expect(urlLinks()).toHaveLength(1);
  expect(urlLinks()[0]).toHaveAttribute("href", sources[1]!.url);
  expect(screen.getByText("11–15 sur 42 sources")).toBeInTheDocument();
});

test("aborts obsolete searches and ignores late responses even if the transport still resolves", async () => {
  const original = fetch;
  const pending = new Map<
    string,
    { signal?: AbortSignal | null; resolve: (response: Response) => void }
  >();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const query = new URL(url, "http://localhost").searchParams.get("q");
      if (url.startsWith("/api/sources?") && query)
        return new Promise<Response>((resolve) => {
          pending.set(query, { signal: init?.signal, resolve });
        });
      return original(url, init);
    }),
  );
  mount();
  await screen.findByRole("table");
  const ui = userEvent.setup();
  const input = screen.getByRole("searchbox", { name: "Rechercher une URL" });
  await ui.click(input);
  await ui.paste("old");
  await waitFor(() => expect(pending.has("old")).toBe(true));
  await ui.clear(input);
  await ui.paste("new");
  await waitFor(() => expect(pending.has("new")).toBe(true));
  expect(pending.get("old")!.signal?.aborted).toBe(true);
  await act(async () => {
    pending
      .get("new")!
      .resolve(
        new Response(JSON.stringify({ sources: [sources[2]], total: 1, page: 1, pageSize: 5 })),
      );
  });
  await screen.findByRole("link", { name: sources[2]!.url });
  await act(async () => {
    pending
      .get("old")!
      .resolve(
        new Response(JSON.stringify({ sources: [sources[0]], total: 100, page: 1, pageSize: 5 })),
      );
  });
  expect(urlLinks().map((link) => link.getAttribute("href"))).toEqual([sources[2]!.url]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("1–1 sur 1 source")).toBeInTheDocument();
});

test("can retry a failed page request without losing the current filters", async () => {
  const original = fetch;
  let failed = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sources?") && failed)
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Chargement indisponible" }), { status: 503 }),
        );
      return original(url, init);
    }),
  );
  mount("/sources?type=scraping&status=active&q=scraping.example");
  expect(await screen.findByRole("alert")).toHaveTextContent("Chargement indisponible");
  failed = false;
  await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  await screen.findByRole("link", { name: "https://scraping.example/news" });
  expect(screen.getByRole("combobox", { name: "Statut des sources" })).toHaveValue("active");
  expect(screen.getByRole("searchbox", { name: "Rechercher une URL" })).toHaveValue(
    "scraping.example",
  );
});
