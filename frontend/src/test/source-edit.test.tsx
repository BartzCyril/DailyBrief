import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { EditSourcePage } from "../pages/EditSourcePage";
import { NavigationFeedback } from "../components/NavigationFeedback";
import type { Source } from "@dailybrief/shared";
import { SourceList } from "../sources/SourceList";
import { sourcesApi } from "../sources/api";
import { sourcePageFixture } from "./fixtures";

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
    descriptionSelector: "p",
    dateSelector: "time",
    mode: "PAGINATE",
    pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 0 },
  },
};
let stored: Source[] = [];
let serverError = "";
let pending: ((response: Response) => void) | undefined;
let pauseSave = false;
const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/test"))
    return new Response(
      JSON.stringify({
        articles: [
          {
            title: "Article de test",
            url: "https://example.com/article",
            description: null,
            publishedAt: null,
          },
        ],
      }),
    );
  if (init?.method === "DELETE") {
    if (serverError) return new Response(JSON.stringify({ message: serverError }), { status: 500 });
    stored = stored.filter((item) => !url.endsWith(`/${item.id}`));
    if (pauseSave)
      return new Promise<Response>((resolve) => {
        pending = resolve;
      });
    return new Response(null, { status: 204 });
  }
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
            ...(body.scrapingConfig ? { scrapingConfig: body.scrapingConfig } : {}),
            ...(body.articleLinkSelector !== undefined
              ? { articleLinkSelector: body.articleLinkSelector }
              : {}),
            ...(body.newestFirst !== undefined ? { newestFirst: body.newestFirst } : {}),
          },
    );
    if (pauseSave)
      return new Promise<Response>((resolve) => {
        pending = resolve;
      });
    return new Response(null, { status: 204 });
  }
  const sourceId = url.match(/\/sources\/([^/?]+)$/)?.[1];
  if (sourceId) {
    const source = stored.find((item) => item.id === sourceId);
    return new Response(JSON.stringify(source ?? { message: "Source introuvable." }), {
      status: source ? 200 : 404,
    });
  }
  return new Response(JSON.stringify(sourcePageFixture(stored, url)));
});
function ListPage() {
  const [sources, setSources] = useState(stored);
  return (
    <>
      <NavigationFeedback />
      <SourceList
        sources={sources}
        onChanged={async () => setSources((await sourcesApi.list()).sources)}
      />
    </>
  );
}
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function Harness({ path = "/sources" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/sources" element={<ListPage />} />
        <Route path="/sources/edit/rss/:sourceId" element={<EditSourcePage />} />
        <Route path="/sources/edit/scraping/:sourceId" element={<EditSourcePage scraping />} />
      </Routes>
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
async function openEdit(source: Source, ui = userEvent.setup()) {
  await ui.click(screen.getByRole("link", { name: `Modifier ${source.url}` }));
  const input = await screen.findByLabelText(
    source.type === "RSS" ? "URL du flux RSS" : "URL du site",
  );
  expect(input).toHaveValue(source.url);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent(
    `/sources/edit/${source.type.toLowerCase()}/${source.id}`,
  );
  fetcher.mockClear();
  return input;
}
async function edit(source: Source, nextUrl: string) {
  const ui = userEvent.setup();
  const input = await openEdit(source, ui);
  await ui.clear(input);
  await ui.type(input, nextUrl);
  return ui;
}
test.each([rss, scraping])(
  "loads a prefilled $type edit page directly and returns to its tab",
  async (source) => {
    render(<Harness path={`/sources/edit/${source.type.toLowerCase()}/${source.id}`} />);
    const input = await screen.findByLabelText(
      source.type === "RSS" ? "URL du flux RSS" : "URL du site",
    );
    expect(input).toHaveValue(source.url);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/sources/${source.id}`);
    expect(screen.getByRole("link", { name: "Aide à la configuration ↗" })).toHaveAttribute(
      "href",
      source.type === "RSS" ? "/documentation#rss" : "/documentation#scraping",
    );
    await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      source.type === "RSS" ? "/sources" : "/sources?type=scraping",
    );
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  },
);
test("corrects the edit route when its type does not match the saved source", async () => {
  render(<Harness path="/sources/edit/rss/s2" />);
  expect(await screen.findByLabelText("URL du site")).toHaveValue(scraping.url);
  expect(screen.getByTestId("location")).toHaveTextContent("/sources/edit/scraping/s2");
  expect(screen.queryByLabelText("URL du flux RSS")).not.toBeInTheDocument();
});
test("handles a missing source and lets the user retry or return to the list", async () => {
  render(<Harness path="/sources/edit/scraping/missing" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Source introuvable.");
  expect(
    screen.queryByRole("button", { name: "Enregistrer les modifications" }),
  ).not.toBeInTheDocument();
  stored = [{ ...scraping, id: "missing" }];
  await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  expect(await screen.findByLabelText("URL du site")).toHaveValue(scraping.url);
  await userEvent.click(screen.getByRole("link", { name: "← Retour aux sources" }));
  expect(screen.getByTestId("location")).toHaveTextContent("/sources?type=scraping");
});
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
test.each(["#reject-cookies", ""])(
  "prefills and changes the saved consent selector to '%s'",
  async (next) => {
    const source: Source = {
      ...scraping,
      scrapingConfig: { ...scraping.scrapingConfig!, cookieConsentSelector: "#accept-cookies" },
    };
    stored = [source];
    render(<Harness />);
    const ui = userEvent.setup();
    await openEdit(source, ui);
    const input = screen.getByLabelText("Sélecteur du bouton de cookies (facultatif)");
    expect(input).toHaveValue("#accept-cookies");
    expect(screen.getByRole("button", { name: "Enregistrer les modifications" })).toBeDisabled();
    await ui.clear(input);
    if (next) await ui.type(input, next);
    await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
    await screen.findByText("Source modifiée.");
    expect(stored[0]?.scrapingConfig?.cookieConsentSelector).toBe(next || undefined);
  },
);

test.each([rss, scraping])("does not expose source ordering for $type", async (source) => {
  stored = [source];
  render(<Harness />);
  await openEdit(source);
  expect(
    screen.queryByRole("switch", { name: "Articles du plus récent au plus ancien" }),
  ).toBeNull();
  expect(screen.queryByLabelText("Sélecteur de description")).toBeNull();
  expect(screen.getByRole("button", { name: "Enregistrer les modifications" })).toBeDisabled();
});
test("preserves an existing chronological setting when only the URL changes", async () => {
  stored = [{ ...rss, newestFirst: true }];
  render(<Harness />);
  const ui = await edit(rss, "https://example.com/new-feed");
  expect(
    screen.queryByRole("switch", { name: "Articles du plus récent au plus ancien" }),
  ).toBeNull();
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.newestFirst).toBe(true);
  const call = fetcher.mock.calls.find((call) => call[1]?.method === "PATCH");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ url: "https://example.com/new-feed" });
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
  expect(screen.getByRole("heading", { name: "Modifier le flux RSS" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
  const template = screen.getByLabelText("Modèle d'URL");
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
    scrapingConfig: {
      ...scraping.scrapingConfig,
      pagination: {
        strategy: "URL_TEMPLATE",
        startPage: 0,
        urlTemplate: "https://example.com/new-news/{page}",
      },
    },
  });
});
test("disables the form while the URL is being verified", async () => {
  pauseSave = true;
  render(<Harness />);
  const ui = await edit(rss, "https://example.com/new-feed");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(screen.getByLabelText("URL du flux RSS")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Annuler" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Vérification et enregistrement…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Tester" })).toBeDisabled();
  expect(screen.queryByRole("link", { name: `Modifier ${scraping.url}` })).not.toBeInTheDocument();
  pending!(new Response(null, { status: 204 }));
  await screen.findByText("Source modifiée.");
});
test("prefills every scraping field and saves selector and mode changes without changing the URL", async () => {
  stored = [
    {
      ...scraping,
      scrapingConfig: {
        ...scraping.scrapingConfig!,
        descriptionSelector: "p",
        dateSelector: "time",
      },
    },
  ];
  render(<Harness />);
  const ui = userEvent.setup();
  await openEdit(scraping, ui);
  expect(screen.getByLabelText("Sélecteur des articles")).toHaveValue("article");
  expect(screen.getByLabelText("Sélecteur du titre")).toHaveValue("h2");
  expect(screen.getByLabelText("Sélecteur du lien")).toHaveValue("a");
  expect(screen.getByLabelText("Sélecteur de date")).toHaveValue("time");
  expect(screen.getByLabelText("Page de départ")).toHaveValue(0);
  expect(screen.getByRole("button", { name: "Enregistrer les modifications" })).toBeDisabled();
  for (const [label, value] of [
    ["Sélecteur des articles", ".card"],
    ["Sélecteur du titre", "h3"],
    ["Sélecteur du lien", ".link"],
    ["Sélecteur de date", ".date"],
  ]) {
    const input = screen.getByLabelText(label!);
    await ui.clear(input);
    if (value) await ui.type(input, value);
  }
  await ui.click(screen.getByRole("combobox", { name: "Mode de récupération" }));
  await ui.click(screen.getByRole("option", { name: "Scroll infini" }));
  await ui.clear(screen.getByLabelText("Nombre maximum de scrolls"));
  await ui.type(screen.getByLabelText("Nombre maximum de scrolls"), "0");
  await ui.clear(screen.getByLabelText("Attente après un scroll (ms)"));
  await ui.type(screen.getByLabelText("Attente après un scroll (ms)"), "250");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.scrapingConfig).toEqual({
    articleSelector: ".card",
    titleSelector: "h3",
    linkSelector: ".link",
    descriptionSelector: "p",
    dateSelector: ".date",
    mode: "SCROLL",
    scroll: { maxScrolls: 0, waitAfterScrollMs: 250 },
  });
  await openEdit(scraping, ui);
  expect(screen.getByLabelText("Nombre maximum de scrolls")).toHaveValue(0);
  expect(screen.getByLabelText("Attente après un scroll (ms)")).toHaveValue(250);
  await ui.click(screen.getByRole("combobox", { name: "Mode de récupération" }));
  await ui.click(screen.getByRole("option", { name: "Pagination" }));
  await ui.clear(screen.getByLabelText("Nom du paramètre"));
  await ui.type(screen.getByLabelText("Nom du paramètre"), "offset");
  await ui.clear(screen.getByLabelText("Page de départ"));
  await ui.type(screen.getByLabelText("Page de départ"), "2");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.scrapingConfig?.pagination).toEqual({
    strategy: "QUERY_PARAM",
    queryParam: "offset",
    startPage: 2,
  });
  expect(stored[0]?.scrapingConfig?.scroll).toBeUndefined();
});
test("tests edited settings without saving, invalidates the preview and refuses empty required selectors", async () => {
  render(<Harness />);
  const ui = await edit(scraping, "https://example.com/new-news");
  await ui.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Article de test");
  expect(stored[1]?.url).toBe(scraping.url);
  const call = fetcher.mock.calls[0]!;
  expect(call[0]).toBe("/api/sources/scraping/test");
  expect(JSON.parse(String(call[1]?.body))).toEqual({
    url: "https://example.com/new-news",
    config: scraping.scrapingConfig,
  });
  await ui.clear(screen.getByLabelText("Sélecteur du titre"));
  expect(screen.queryByText("Article de test")).not.toBeInTheDocument();
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("sélecteurs requis");
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
});
test("requires the date when testing or saving changes to a source", async () => {
  render(<Harness />);
  const ui = await edit(scraping, "https://example.com/new-news");
  for (const label of ["Sélecteur de date"]) {
    const input = screen.getByLabelText(label);
    expect(input).toBeRequired();
    const selector = (input as HTMLInputElement).value;
    await ui.clear(input);
    await ui.click(screen.getByRole("button", { name: "Tester" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("sélecteur de date est obligatoire");
    await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(stored[1]?.scrapingConfig).toEqual(scraping.scrapingConfig);
    await ui.type(input, selector);
  }
});
test("prefills and edits load-more fields, then drops them when changing modes", async () => {
  const source: Source = {
    ...scraping,
    scrapingConfig: {
      articleSelector: "article",
      titleSelector: "h2",
      linkSelector: "a",
      descriptionSelector: "p",
      dateSelector: "time",
      mode: "LOAD_MORE",
      loadMore: { buttonSelector: ".more", waitTimeoutMs: 25000 },
    },
  };
  stored = [source];
  render(<Harness />);
  const ui = userEvent.setup();
  await openEdit(source, ui);
  expect(screen.getByLabelText("Sélecteur du bouton")).toHaveValue(".more");
  expect(screen.getByLabelText("Délai maximum après un clic (ms)")).toHaveValue(25000);
  await ui.clear(screen.getByLabelText("Sélecteur du bouton"));
  await ui.type(screen.getByLabelText("Sélecteur du bouton"), "#next");
  await ui.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Article de test");
  expect(stored[0]?.scrapingConfig).toEqual(source.scrapingConfig);
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.scrapingConfig?.loadMore).toEqual({
    buttonSelector: "#next",
    waitTimeoutMs: 25000,
  });
  await openEdit(source, ui);
  expect(screen.getByLabelText("Sélecteur du bouton")).toHaveValue("#next");
  await ui.click(screen.getByRole("combobox", { name: "Mode de récupération" }));
  await ui.click(screen.getByRole("option", { name: "Pagination" }));
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.scrapingConfig?.mode).toBe("PAGINATE");
  expect(stored[0]?.scrapingConfig?.loadMore).toBeUndefined();
});
test("confirms RSS deletion, permits cancellation and refreshes the list after deletion", async () => {
  render(<Harness />);
  const ui = userEvent.setup();
  const remove = screen.getByRole("button", { name: `Supprimer ${rss.url}` });
  await ui.click(remove);
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("Êtes-vous sûr de vouloir supprimer ce flux RSS ?");
  expect(dialog).toHaveTextContent("articles et résumés associés");
  expect(fetcher.mock.calls).toHaveLength(0);
  await ui.click(within(dialog).getByRole("button", { name: "Annuler" }));
  expect(remove).toHaveFocus();
  expect(screen.getByText(rss.url)).toBeInTheDocument();
  await openEdit(rss, ui);
  await ui.click(screen.getByRole("button", { name: "Annuler" }));
  await ui.click(screen.getByRole("button", { name: `Supprimer ${rss.url}` }));
  await ui.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }),
  );
  await screen.findByText("Source supprimée.");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/sources/s1");
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
  expect(screen.queryByText(rss.url)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("URL du flux RSS")).not.toBeInTheDocument();
  expect(screen.getByText(scraping.url)).toBeInTheDocument();
});
test("keeps a source on deletion failure and permits retry in the scraping confirmation dialog", async () => {
  stored = [scraping];
  serverError = "Suppression impossible.";
  render(<Harness />);
  const ui = userEvent.setup();
  await ui.click(screen.getByRole("button", { name: `Supprimer ${scraping.url}` }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("Êtes-vous sûr de vouloir supprimer cette source de scraping ?");
  await ui.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Suppression impossible.");
  expect(stored).toEqual([scraping]);
  serverError = "";
  await ui.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  await screen.findByText("Source supprimée.");
  expect(screen.getByText(/Aucune source configurée/)).toBeInTheDocument();
});
test("blocks competing changes and closing the dialog while deletion is pending", async () => {
  pauseSave = true;
  render(<Harness />);
  const ui = userEvent.setup();
  await ui.click(screen.getByRole("button", { name: `Supprimer ${scraping.url}` }));
  const dialog = screen.getByRole("alertdialog");
  await ui.click(within(dialog).getByRole("button", { name: "Supprimer" }));
  expect(within(dialog).getByRole("button", { name: "Annuler" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Suppression en cours…" })).toBeDisabled();
  for (const source of [rss, scraping]) {
    expect(
      screen.getByRole("link", { name: `Modifier ${source.url}`, hidden: true }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: `Supprimer ${source.url}`, hidden: true }),
    ).toBeDisabled();
  }
  for (const control of screen.getAllByRole("switch", { hidden: true }))
    expect(control).toBeDisabled();
  await ui.keyboard("{Escape}");
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  pending!(new Response(null, { status: 204 }));
  await screen.findByText("Source supprimée.");
  expect(screen.getByRole("button", { name: `Supprimer ${rss.url}` })).toBeEnabled();
});

test("prefills, updates and clears the RSS document selector while keeping the URL", async () => {
  stored = [{ ...rss, articleLinkSelector: "a.primarydoc" }, scraping];
  render(<Harness />);
  const ui = userEvent.setup();
  await openEdit(rss, ui);
  const field = screen.getByLabelText("Sélecteur du lien vers l'article (facultatif)");
  expect(field).toHaveValue("a.primarydoc");
  expect(screen.getByRole("button", { name: "Enregistrer les modifications" })).toBeDisabled();
  await ui.clear(field);
  await ui.type(field, "a.document");
  await ui.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Article de test");
  expect(stored[0]?.articleLinkSelector).toBe("a.primarydoc");
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.articleLinkSelector).toBe("a.document");
  await openEdit(rss, ui);
  await ui.clear(screen.getByLabelText("Sélecteur du lien vers l'article (facultatif)"));
  await ui.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));
  await screen.findByText("Source modifiée.");
  expect(stored[0]?.articleLinkSelector).toBeNull();
  const edits = fetcher.mock.calls.filter((call) => call[1]?.method === "PATCH");
  expect(JSON.parse(String(edits.at(-1)?.[1]?.body))).toEqual({
    url: rss.url,
    articleLinkSelector: null,
  });
});
