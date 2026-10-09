import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { JournalTable } from "../sources/JournalTable";
import type { JournalPreview } from "@dailybrief/shared";

const initial: JournalPreview[] = [
  {
    domain: "www.lemonde.fr",
    count: 12,
    enabled: false,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
  },
  {
    domain: "www.lefigaro.fr",
    count: 7,
    enabled: false,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
  },
];
let bodies: Record<string, unknown>[];
beforeEach(() => {
  bodies = [];
  let current = { ...initial[0]! };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      bodies.push(body);
      current = {
        ...current,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.password ? { hasCredentials: true } : {}),
        ...(body.clearCredentials ? { email: null, hasCredentials: false } : {}),
      };
      return new Response(JSON.stringify(current));
    }),
  );
});
function Harness() {
  const [journals, setJournals] = useState(initial);
  return (
    <JournalTable
      journals={journals}
      onChange={(journal) =>
        setJournals((previous) =>
          previous.map((item) => (item.domain === journal.domain ? journal : item)),
        )
      }
    />
  );
}
test("renders counts, keyboard activation and credential editing with no password re-display", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const rows = screen.getAllByRole("row");
  expect(within(rows[1]!).getByRole("link")).toHaveTextContent("www.lemonde.fr");
  expect(within(rows[1]!).getByText("12")).toBeInTheDocument();
  expect(within(rows[2]!).getByText("7")).toBeInTheDocument();
  expect(within(rows[1]!).getByRole("button", { name: "Configurer l'accès" })).toBeDisabled();
  screen.getByRole("button", { name: "Activer www.lemonde.fr" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "Désactiver www.lemonde.fr" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(within(rows[1]!).getByRole("button", { name: "Configurer l'accès" }));
  await user.type(screen.getByLabelText("Email pour www.lemonde.fr"), "reader@example.com");
  await user.type(screen.getByLabelText("Mot de passe"), "secret-for-test");
  await user.click(screen.getByRole("button", { name: "Enregistrer les identifiants" }));
  expect(await screen.findByText(/connexion non prise en charge/)).toBeInTheDocument();
  expect(bodies.at(-1)).toMatchObject({ email: "reader@example.com", password: "secret-for-test" });
  expect(screen.queryByDisplayValue("secret-for-test")).not.toBeInTheDocument();
  await user.click(within(rows[1]!).getByRole("button", { name: "Configurer l'accès" }));
  expect(screen.getByLabelText(/Nouveau mot de passe/)).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Enregistrer les identifiants" }));
  await waitFor(() => expect(bodies.at(-1)).toMatchObject({ password: "" }));
  await user.click(screen.getByRole("button", { name: "Supprimer les identifiants" }));
  await waitFor(() => expect(bodies.at(-1)).toEqual({ clearCredentials: true }));
  expect(screen.queryByText(/connexion non prise en charge/)).not.toBeInTheDocument();
});
