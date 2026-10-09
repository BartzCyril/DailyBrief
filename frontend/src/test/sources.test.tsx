import { emptyDashboard } from "./fixtures";
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
const preview = {
  feed: { title: "Mon flux", url: "https://example.com/feed" },
  articles: [
    {
      title: "Un article",
      url: "https://example.com/article",
      publishedAt: "2026-10-06T10:00:00Z",
      description: "Une description",
    },
  ],
};
const source = {
  id: "s1",
  type: "RSS",
  url: "https://example.com/feed",
  enabled: true,
  scrapingConfig: null,
};
let duplicate = false;
let badTest = false;
let saved = false;
let warnings: string[] = [];
function mockApi() {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/journals"))
      return new Response(
        JSON.stringify({ journals: [], lastInventoriedAt: null, unresolvedCount: 0 }),
      );
    if (url.endsWith("/dashboard")) return new Response(JSON.stringify(emptyDashboard));
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ id: "u1", email: "reader@example.com" }));
    if (url.endsWith("/rss/test"))
      return new Response(
        JSON.stringify(badTest ? { message: "Flux inaccessible" } : { ...preview, warnings }),
        {
          status: badTest ? 422 : 200,
        },
      );
    if (url.endsWith("/sources") && init?.method === "POST") {
      saved = !duplicate;
      return new Response(
        JSON.stringify(duplicate ? { message: "Cette entrée existe déjà." } : source),
        { status: duplicate ? 409 : 201 },
      );
    }
    if (url.endsWith("/sources")) return new Response(JSON.stringify(saved ? [source] : []));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
function mount(path = "/sources/new/rss") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  duplicate = false;
  badTest = false;
  saved = false;
  warnings = [];
  mockApi();
});
test("opens the RSS form from the authenticated dashboard", async () => {
  mount("/dashboard");
  await userEvent.click(await screen.findByRole("link", { name: "Ajouter un flux RSS" }));
  expect(await screen.findByLabelText("URL du flux RSS")).toBeInTheDocument();
});
test("requires successful test before saving and rejects invalid URL", async () => {
  mount();
  expect(await screen.findByRole("button", { name: "Enregistrer le flux" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("URL du flux RSS"), "invalid");
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("URL HTTP");
});
test("shows preview articles and invalidates preview when URL changes", async () => {
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  expect(await screen.findByText("Un article")).toBeInTheDocument();
  expect(screen.getByText("Une description")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Lire l'article/ })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await userEvent.type(screen.getByLabelText("URL du flux RSS"), "?new=1");
  expect(screen.getByRole("button", { name: "Enregistrer le flux" })).toBeDisabled();
  expect(screen.queryByText("Un article")).not.toBeInTheDocument();
});
test("saves the tested URL without userId and refreshes the list", async () => {
  const mock = mockApi();
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Un article");
  await userEvent.click(screen.getByRole("button", { name: "Enregistrer le flux" }));
  expect(await screen.findByText(source.url)).toBeInTheDocument();
  const call = mock.mock.calls.find(
    (call) => call[0] === "/api/sources" && call[1]?.method === "POST",
  );
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ url: source.url, type: "RSS" });
});
test("shows normalization warnings without blocking a usable RSS preview", async () => {
  warnings = ["Les esperluettes et entités HTML non échappées ont été normalisées."];
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  expect(await screen.findByRole("status")).toHaveTextContent(warnings[0]!);
  expect(screen.getByText("Un article")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enregistrer le flux" })).toBeEnabled();
  await userEvent.type(screen.getByLabelText("URL du flux RSS"), "?changed=1");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enregistrer le flux" })).toBeDisabled();
});
test("shows test errors and duplicate errors", async () => {
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  badTest = true;
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Flux inaccessible");
  badTest = false;
  duplicate = true;
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Un article");
  await userEvent.click(screen.getByRole("button", { name: "Enregistrer le flux" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("existe déjà");
});
test("disables incompatible actions while testing", async () => {
  let resolve: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("/rss/test")
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : Promise.resolve(new Response(JSON.stringify({ id: "u1", email: "reader@example.com" }))),
    ),
  );
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  expect(screen.getByRole("button", { name: /Test du flux en cours/ })).toBeDisabled();
  expect(screen.getByLabelText("URL du flux RSS")).toBeDisabled();
  resolve(new Response(JSON.stringify(preview)));
  await screen.findByText("Un article");
});

test("saves the optional RSS document selector and invalidates the preview when it changes", async () => {
  const mock = mockApi();
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  const field = screen.getByLabelText("Sélecteur du lien vers l'article (facultatif)");
  await userEvent.type(field, "a.accessToPrimaryDoc.primarydoc");
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Un article");
  const tested = mock.mock.calls.find((call) => call[0].endsWith("/rss/test"));
  expect(JSON.parse(String(tested?.[1]?.body))).toEqual({
    url: source.url,
    articleLinkSelector: "a.accessToPrimaryDoc.primarydoc",
  });
  await userEvent.type(field, ".changed");
  expect(screen.queryByText("Un article")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enregistrer le flux" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText("Un article");
  await userEvent.click(screen.getByRole("button", { name: "Enregistrer le flux" }));
  await screen.findByText(source.url);
  const saved = mock.mock.calls.find(
    (call) => call[0] === "/api/sources" && call[1]?.method === "POST",
  );
  expect(JSON.parse(String(saved?.[1]?.body))).toEqual({
    url: source.url,
    type: "RSS",
    articleLinkSelector: "a.accessToPrimaryDoc.primarydoc.changed",
  });
});

test("rejects invalid RSS document selector syntax before testing the feed", async () => {
  const mock = mockApi();
  mount();
  await userEvent.type(await screen.findByLabelText("URL du flux RSS"), source.url);
  await userEvent.type(
    screen.getByLabelText("Sélecteur du lien vers l'article (facultatif)"),
    "a[[",
  );
  await userEvent.click(screen.getByRole("button", { name: "Tester" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("sélecteur CSS valide");
  expect(mock.mock.calls.some((call) => call[0].endsWith("/rss/test"))).toBe(false);
});
