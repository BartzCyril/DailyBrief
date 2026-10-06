import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
const user = { id: "u1", email: "reader@example.com" };
function mockApi(current = false) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me")) return new Response(JSON.stringify(current ? user : { message: "Unauthorized" }), { status: current ? 200 : 401 });
    if (url.endsWith("/auth/login")) { current = true; return new Response(JSON.stringify(user)); }
    if (url.endsWith("/auth/logout")) { current = false; return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify(user), { status: 201 });
  }); vi.stubGlobal("fetch", mock); return mock;
}
function mount(path = "/login") { render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>); }
beforeEach(() => { mockApi(); });
test("shows accessible login and redirects protected routes", async () => { mount("/dashboard"); expect(await screen.findByRole("button", { name: "Se connecter" })).toBeInTheDocument(); expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email"); });
test("logs in with credentials and logs out", async () => {
  const mock = mockApi(); mount(); const ui = userEvent.setup(); await ui.type(screen.getByLabelText("Email"), user.email); await ui.type(screen.getByLabelText("Mot de passe"), "Password123456"); await ui.click(screen.getByRole("button", { name: "Se connecter" }));
  expect(await screen.findByText(user.email)).toBeInTheDocument(); expect(mock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ credentials: "include" }));
  await ui.click(screen.getByRole("button", { name: "Se déconnecter" })); expect(await screen.findByRole("button", { name: "Se connecter" })).toBeInTheDocument();
});
test("loads the existing account through me", async () => { mockApi(true); mount("/dashboard"); expect(await screen.findByText(user.email)).toBeInTheDocument(); });
test("shows API login errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Identifiants invalides" }), { status: 401 }))); mount(); const ui = userEvent.setup(); await ui.type(screen.getByLabelText("Email"), user.email); await ui.type(screen.getByLabelText("Mot de passe"), "wrong"); await ui.click(screen.getByRole("button", { name: "Se connecter" })); expect(await screen.findByRole("alert")).toHaveTextContent("Identifiants invalides");
});
test("validates registration password confirmation without calling registration", async () => {
  const mock = mockApi(); mount("/register"); const ui = userEvent.setup(); await ui.type(screen.getByLabelText("Email"), user.email); await ui.type(screen.getByLabelText("Mot de passe"), "Password123456"); await ui.type(screen.getByLabelText("Confirmer le mot de passe"), "Different123456"); await ui.click(screen.getByRole("button", { name: "Créer le compte" })); expect(await screen.findByRole("alert")).toHaveTextContent("ne correspondent pas"); expect(mock.mock.calls.some(call => call[0].endsWith("/register"))).toBe(false);
});
test("registers successfully and clears passwords", async () => {
  mount("/register"); const ui = userEvent.setup(); await ui.type(screen.getByLabelText("Email"), user.email); for (const name of ["Mot de passe", "Confirmer le mot de passe"]) await ui.type(screen.getByLabelText(name), "Password123456"); await ui.click(screen.getByRole("button", { name: "Créer le compte" })); expect(await screen.findByRole("status")).toHaveTextContent("Compte créé"); expect(screen.getByLabelText("Mot de passe")).toHaveValue("");
});
