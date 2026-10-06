import { test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
const preview = { mode: "SCROLL", articles: [{ title: "Article extrait", url: "https://example.com/article", description: "Détails", publishedAt: null }] };
let saved = false; let fail = false;
function mockApi() { const mock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ id: "u1", email: "reader@example.com" }));
  if (url.endsWith("/scraping/test")) return new Response(JSON.stringify(fail ? { message: "Sélecteurs invalides" } : preview), { status: fail ? 422 : 200 });
  if (url.endsWith("/sources") && init?.method === "POST") { saved = true; return new Response(JSON.stringify({ id: "s1" }), { status: 201 }); }
  if (url.endsWith("/sources")) return new Response(JSON.stringify(saved ? [{ id: "s1", url: "https://example.com/news", type: "SCRAPING", enabled: true, scrapingConfig: { mode: "SCROLL" } }] : []));
  return new Response("{}");
}); vi.stubGlobal("fetch", mock); return mock; }
function mount(path = "/sources/new/scraping") { render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>); }
async function fill() { const ui = userEvent.setup(); await ui.type(await screen.findByLabelText("URL du site"), "https://example.com/news"); await ui.type(screen.getByLabelText("Sélecteur des articles"), "article"); await ui.type(screen.getByLabelText("Sélecteur du titre"), "h2"); await ui.type(screen.getByLabelText("Sélecteur du lien"), "a"); return ui; }
async function choose(label: string, choice: string) { await userEvent.click(screen.getByRole("combobox", { name: label })); await userEvent.click(screen.getByRole("option", { name: choice })); }
beforeEach(() => { saved = false; fail = false; mockApi(); });
test("opens scraping from dashboard and validates URL and selectors", async () => {
  mount("/dashboard"); await userEvent.click(await screen.findByRole("link", { name: "Ajouter une source de scraping" })); await screen.findByLabelText("URL du site"); await userEvent.click(screen.getByRole("button", { name: "Tester" })); expect(await screen.findByRole("alert")).toHaveTextContent("URL HTTP");
  await userEvent.type(screen.getByLabelText("URL du site"), "https://example.com"); await userEvent.click(screen.getByRole("button", { name: "Tester" })); expect(await screen.findByRole("alert")).toHaveTextContent("sélecteurs requis");
});
test("shows only the controls for the selected mode and supports both pagination strategies", async () => {
  mount(); await screen.findByLabelText("URL du site"); expect(screen.getByLabelText("Nombre maximum de scrolls")).toBeInTheDocument();
  await choose("Mode de récupération", "Pagination"); expect(screen.queryByLabelText("Nombre maximum de scrolls")).not.toBeInTheDocument(); expect(screen.getByLabelText("Nom du paramètre")).toBeInTheDocument(); expect(screen.getByLabelText("Nombre maximum de pages")).toBeInTheDocument();
  await choose("Stratégie de pagination", "Modèle d'URL"); expect(screen.getByLabelText("Modèle d'URL")).toBeInTheDocument(); expect(screen.queryByLabelText("Nom du paramètre")).not.toBeInTheDocument();
});
test("requires a page placeholder for template pagination", async () => {
  mount(); const ui = await fill(); await choose("Mode de récupération", "Pagination"); await choose("Stratégie de pagination", "Modèle d'URL"); await ui.type(screen.getByLabelText("Modèle d'URL"), "https://example.com/no-placeholder"); await ui.click(screen.getByRole("button", { name: "Tester" })); expect(await screen.findByRole("alert")).toHaveTextContent("{page}");
});
test("tests SCROLL configuration, previews articles and invalidates on a selector change", async () => {
  const mock = mockApi(); mount(); const ui = await fill(); expect(screen.getByRole("button", { name: "Enregistrer la source" })).toBeDisabled(); await ui.click(screen.getByRole("button", { name: "Tester" })); expect(await screen.findByText("Article extrait")).toBeInTheDocument();
  const call = mock.mock.calls.find(call => call[0].endsWith("/scraping/test")); expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ config: { mode: "SCROLL", scroll: { maxScrolls: 3, waitAfterScrollMs: 1000 } } });
  await ui.type(screen.getByLabelText("Sélecteur du titre"), ".new"); expect(screen.getByRole("button", { name: "Enregistrer la source" })).toBeDisabled(); expect(screen.queryByText("Article extrait")).not.toBeInTheDocument();
});
test("sends QUERY_PARAM config and invalidates when parameters change", async () => {
  const mock = mockApi(); mount(); const ui = await fill(); await choose("Mode de récupération", "Pagination"); await ui.click(screen.getByRole("button", { name: "Tester" })); await screen.findByText("Article extrait");
  const call = mock.mock.calls.find(call => call[0].endsWith("/scraping/test")); expect(JSON.parse(String(call?.[1]?.body)).config.pagination).toMatchObject({ strategy: "QUERY_PARAM", queryParam: "page", maxPages: 3, startPage: 1 });
  await ui.clear(screen.getByLabelText("Nombre maximum de pages")); expect(screen.getByRole("button", { name: "Enregistrer la source" })).toBeDisabled();
});
test("saves a tested scraping source without userId and lists its mode", async () => {
  const mock = mockApi(); mount(); const ui = await fill(); await ui.click(screen.getByRole("button", { name: "Tester" })); await screen.findByText("Article extrait"); await ui.click(screen.getByRole("button", { name: "Enregistrer la source" })); expect(await screen.findByText("SCRAPING")).toBeInTheDocument(); expect(screen.getByText("SCROLL")).toBeInTheDocument();
  const call = mock.mock.calls.find(call => call[0].endsWith("/sources") && call[1]?.method === "POST"); const body = JSON.parse(String(call?.[1]?.body)); expect(body.type).toBe("SCRAPING"); expect(body.userId).toBeUndefined();
});
test("shows scraping errors and keeps save disabled", async () => { fail = true; mount(); const ui = await fill(); await ui.click(screen.getByRole("button", { name: "Tester" })); expect(await screen.findByRole("alert")).toHaveTextContent("Sélecteurs invalides"); expect(screen.getByRole("button", { name: "Enregistrer la source" })).toBeDisabled(); });
