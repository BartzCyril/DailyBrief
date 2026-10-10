import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { inspectSelector, SelectorPlayground } from "../documentation/SelectorPlayground";

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ message: "Non connecté" }), { status: 401 })),
  );
});
function mount(path = "/") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
test("the public home works without a session and leads to registration", async () => {
  mount();
  expect(
    await screen.findByRole("heading", { level: 1, name: /Moins d’onglets/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Navigation publique" })).toBeInTheDocument();
  await userEvent.setup().click(screen.getAllByRole("link", { name: "Créer ma veille" })[0]!);
  expect(await screen.findByRole("heading", { name: "Créer votre compte" })).toBeInTheDocument();
});
test("the documentation remains available when the backend is unreachable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Offline");
    }),
  );
  mount("/documentation");
  expect(
    await screen.findByRole("heading", { level: 1, name: /Votre veille commence/ }),
  ).toBeInTheDocument();
  const nav = screen.getByRole("navigation", { name: "Sommaire de la documentation" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(document.getElementById(link.getAttribute("href")!.slice(1))).toBeInTheDocument();
  }
  expect(within(nav).getAllByRole("link")).toHaveLength(10);
  expect(document.title).toBe("Guide d’utilisation · DailyBrief");
  expect(screen.getAllByRole("img")).toHaveLength(8);
});
test("the chapter search handles accents and shows empty results", async () => {
  mount("/documentation");
  const input = await screen.findByLabelText("Rechercher un chapitre");
  const ui = userEvent.setup();
  await ui.type(input, "abonnement");
  const nav = screen.getByRole("navigation", { name: "Sommaire de la documentation" });
  expect(within(nav).getAllByRole("link")).toHaveLength(1);
  expect(within(nav).getByRole("link", { name: "Configurer les journaux" })).toHaveAttribute(
    "href",
    "#journaux",
  );
  await ui.clear(input);
  await ui.type(input, "selecteurs");
  expect(within(nav).getByRole("link", { name: "Trouver les sélecteurs" })).toBeInTheDocument();
  await ui.clear(input);
  await ui.type(input, "inexistant");
  expect(within(nav).queryAllByRole("link")).toHaveLength(0);
  expect(screen.getByText(/Aucun chapitre trouvé/)).toBeInTheDocument();
});
test("the selector playground supports examples, invalid syntax and missing matches without calling the API", async () => {
  render(<SelectorPlayground />);
  const ui = userEvent.setup();
  const input = screen.getByLabelText("Sélecteur à l’intérieur du bloc article");
  await ui.click(screen.getByRole("button", { name: ".description" }));
  expect(input).toHaveValue(".description");
  expect(screen.getByRole("status")).toHaveTextContent("1 élément trouvé");
  expect(screen.getByRole("status")).toHaveTextContent('<p class="description">');
  await ui.clear(input);
  await ui.type(input, "[[");
  expect(screen.getByRole("status")).toHaveTextContent("n’est pas valide");
  await ui.clear(input);
  await ui.type(input, ".absent");
  expect(screen.getByRole("status")).toHaveTextContent("0 élément trouvé");
  expect(fetch).not.toHaveBeenCalled();
});
test("selectors query an isolated article rather than the live document", () => {
  expect(inspectSelector("time").matches[0]).toContain('datetime="2026-10-10"');
  expect(inspectSelector("h2 a.title").matches).toHaveLength(1);
  expect(inspectSelector("script").matches).toHaveLength(0);
  expect(inspectSelector("body").matches).toHaveLength(0);
  expect(inspectSelector("").error).toContain("Saisissez");
});
