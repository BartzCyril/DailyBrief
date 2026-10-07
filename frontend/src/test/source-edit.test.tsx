import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Source } from "@dailybrief/shared";
import { SourceList } from "../sources/SourceList";
import { sourcesApi } from "../sources/api";

const rss: Source = {
  id: "s1",
  url: "https://example.com/feed",
  type: "RSS",
  enabled: false,
  scrapingConfig: null,
};
const scraping: Source = {
  id: "s2",
  url: "https://example.com/news",
  type: "SCRAPING",
  enabled: true,
  scrapingConfig: {
    articleSelector: "article",
    titleSelector: "h2",
    linkSelector: "a",
    mode: "PAGINATE",
    pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 0 },
  },
};
let stored: Source[] = [];
let serverError = "";
let pending: ((response: Response) => void) | undefined;
let pauseSave = false;
const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "PATCH") {
    if (serverError) return new Response(JSON.stringify({ message: serverError }), { status: 409 });
    const body = JSON.parse(String(init.body));
    const source = stored.find((item) => url.endsWith(`/${item.id}`))!;
    stored = stored.map((item) =>
      item.id !== source.id
        ? item
        : {
            ...item,
            url: body.url ?? item.url,
            ...(body.urlTemplate
              ? {
                  scrapingConfig: {
                    ...item.scrapingConfig!,
                    pagination: {
                      ...item.scrapingConfig!.pagination!,
                      urlTemplate: body.urlTemplate,
                    },
                  },
                }
              : {}),
          },
    );
    if (pauseSave)
      return new Promise<Response>((resolve) => {
        pending = resolve;
      });
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(stored));
});
function Harness() {
  const [sources, setSources] = useState(stored);
  return (
    <MemoryRouter>
      <SourceList sources={sources} onChanged={async () => setSources(await sourcesApi.list())} />
    </MemoryRouter>
  );
}
beforeEach(() => {
  stored = [rss, scraping];
  serverError = "";
  pending = undefined;
  pauseSave = false;
  fetcher.mockClear();
  vi.stubGlobal("fetch", fetcher);
});
async function edit(source: Source, nextUrl: string) {
  const ui = userEvent.setup();
  await ui.click(screen.getByRole("button", { name: `Modifier ${source.url}` }));
  const input = screen.getByLabelText(source.type === "RSS" ? "URL du flux RSS" : "URL du site");
  expect(input).toHaveValue(source.url);
  await ui.clear(input);
  await ui.type(input, nextUrl);
  return ui;
}
test("edits an RSS URL in place, refreshes the list and preserves the disabled source", async () => {
  render(<Harness />);
  const ui = await edit(rss, "https://example.com/new-feed");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(await screen.findByText("Source modifiée.")).toBeInTheDocument();
  expect(screen.getByText("https://example.com/new-feed")).toBeInTheDocument();
  expect(screen.queryByText(rss.url)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("URL du flux RSS")).not.toBeInTheDocument();
  const call = fetcher.mock.calls.find((call) => call[1]?.method === "PATCH");
  expect(call?.[0]).toBe("/api/sources/s1");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ url: "https://example.com/new-feed" });
  expect(
    screen.getByRole("switch", { name: "Activer https://example.com/new-feed" }),
  ).not.toBeChecked();
});
test("edits a scraping URL without replacing its extraction configuration", async () => {
  render(<Harness />);
  const ui = await edit(scraping, "https://example.com/new-news");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[1]?.scrapingConfig).toEqual(scraping.scrapingConfig);
  expect(
    screen.getByRole("switch", { name: "Activer https://example.com/new-news" }),
  ).toBeChecked();
});
test("cancels editing and refuses invalid URLs without a server mutation", async () => {
  render(<Harness />);
  const ui = await edit(rss, "invalid");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("URL HTTP ou HTTPS");
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  await ui.click(screen.getByRole("button", { name: "Annuler" }));
  expect(screen.queryByLabelText("URL du flux RSS")).not.toBeInTheDocument();
  expect(screen.getByText(rss.url)).toBeInTheDocument();
});
test("keeps the edited value and old source on a save error, allowing retry", async () => {
  serverError = "Une source utilise déjà cette URL.";
  render(<Harness />);
  const ui = await edit(rss, "https://example.com/taken");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("déjà cette URL");
  expect(screen.getByLabelText("URL du flux RSS")).toHaveValue("https://example.com/taken");
  expect(screen.getByText(rss.url)).toBeInTheDocument();
  serverError = "";
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(await screen.findByText("Source modifiée.")).toBeInTheDocument();
});
test("supports changing a pagination template with validation of its page placeholder", async () => {
  stored = [
    {
      ...scraping,
      scrapingConfig: {
        ...scraping.scrapingConfig!,
        pagination: {
          strategy: "URL_TEMPLATE",
          startPage: 0,
          urlTemplate: "https://example.com/news/{page}",
        },
      },
    },
  ];
  render(<Harness />);
  const ui = await edit(scraping, "https://example.com/new-news");
  const template = screen.getByLabelText("Modèle d'URL de pagination");
  expect(template).toHaveValue("https://example.com/new-news/{page}");
  await ui.clear(template);
  await ui.type(template, "https://example.com/no-page");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("{page}");
  expect(fetcher.mock.calls).toHaveLength(0);
  await ui.clear(template);
  await ui.paste("https://example.com/new-news/{page}");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    url: "https://example.com/new-news",
    urlTemplate: "https://example.com/new-news/{page}",
  });
});
test("disables competing edits and activation while the URL is being verified", async () => {
  pauseSave = true;
  render(<Harness />);
  const ui = await edit(rss, "https://example.com/new-feed");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(screen.getByLabelText("URL du flux RSS")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Annuler" })).toBeDisabled();
  expect(screen.getByRole("button", { name: `Modifier ${scraping.url}` })).toBeDisabled();
  for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled();
  pending!(new Response(null, { status: 204 }));
  await screen.findByText("Source modifiée.");
});
