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
let testCalls = 0;
let failConnection = false;
beforeEach(() => {
  bodies = [];
  testCalls = 0;
  failConnection = false;
  let current = { ...initial[0]! };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/test")) {
        testCalls++;
        return new Response(
          JSON.stringify(
            failConnection
              ? { message: "Connexion refusée", code: "JOURNAL_LOGIN_FAILED" }
              : {
                  authenticated: true,
                  message: "Connexion vérifiée. La session de test a été fermée.",
                },
          ),
          { status: failConnection ? 422 : 200 },
        );
      }
      const body = JSON.parse(options.body as string);
      bodies.push(body);
      current = {
        ...current,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.password ? { hasCredentials: true } : {}),
        ...(body.clearCredentials ? { email: null, hasCredentials: false } : {}),
        ...(body.loginConfig !== undefined
          ? {
              loginConfig: body.loginConfig as JournalPreview["loginConfig"],
              authenticationSupported: Boolean(body.loginConfig),
            }
          : {}),
      };
      return new Response(JSON.stringify(current));
    }),
  );
});
test("saves form selectors, tests the saved login and distinguishes configuration from successful authentication", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Activer www.lemonde.fr" }));
  await user.click(screen.getAllByRole("button", { name: "Configurer l'accès" })[0]!);
  await user.type(screen.getByLabelText("Email pour www.lemonde.fr"), "reader@example.com");
  await user.type(screen.getByLabelText("Mot de passe", { exact: true }), "secret-for-test");
  await user.type(
    screen.getByLabelText("URL du formulaire de connexion"),
    "https://secure.lemonde.fr/login",
  );
  for (const [label, value] of [
    ["Sélecteur du champ email", "#email"],
    ["Sélecteur du champ mot de passe", "#password"],
    ["Sélecteur du bouton de connexion", "#submit"],
    ["Sélecteur visible après connexion", ".account"],
    ["Sélecteur du contenu intégral (facultatif)", ".full-article"],
  ]) {
    const field = screen.getByLabelText(label!);
    await user.clear(field);
    await user.type(field, value!);
  }
  await user.click(screen.getByRole("button", { name: "Enregistrer les identifiants" }));
  expect(
    await screen.findByText(/Formulaire configuré · connexion à vérifier/),
  ).toBeInTheDocument();
  expect(bodies.at(-1)?.loginConfig).toEqual({
    loginUrl: "https://secure.lemonde.fr/login",
    emailSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#submit",
    successSelector: ".account",
    articleContentSelector: ".full-article",
  });
  expect(screen.queryByDisplayValue("secret-for-test")).not.toBeInTheDocument();
  const testButton = screen.getByRole("button", { name: "Tester la connexion" });
  testButton.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText(/Connexion vérifiée/)).toBeInTheDocument();
  expect(testCalls).toBe(1);
  failConnection = true;
  await user.click(screen.getByRole("button", { name: "Tester la connexion" }));
  expect(await screen.findByText("Connexion refusée")).toBeInTheDocument();
  expect(screen.queryByText(/Connexion vérifiée/)).not.toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Configurer l'accès" })[0]!);
  expect(screen.getByLabelText("URL du formulaire de connexion")).toHaveValue(
    "https://secure.lemonde.fr/login",
  );
  expect(screen.getByLabelText("Sélecteur visible après connexion")).toHaveValue(".account");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Configurer l'accès à www.lemonde.fr");
  expect(screen.queryByRole("button", { name: "Tester la connexion" })).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Nouveau mot de passe/)).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Annuler" }));
  await user.click(screen.getByRole("button", { name: "Supprimer le formulaire" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "Êtes-vous sûr de vouloir supprimer ce formulaire de connexion ?",
  );
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }),
  );
  await waitFor(() => expect(bodies.at(-1)).toEqual({ loginConfig: null }));
  expect(screen.queryByRole("button", { name: "Tester la connexion" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Supprimer les identifiants" })).toBeInTheDocument();
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
  expect(await screen.findByText(/formulaire à configurer/)).toBeInTheDocument();
  expect(bodies.at(-1)).toMatchObject({ email: "reader@example.com", password: "secret-for-test" });
  expect(screen.queryByDisplayValue("secret-for-test")).not.toBeInTheDocument();
  await user.click(within(rows[1]!).getByRole("button", { name: "Configurer l'accès" }));
  expect(screen.getByLabelText(/Nouveau mot de passe/)).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Enregistrer les identifiants" }));
  await waitFor(() => expect(bodies.at(-1)).toMatchObject({ password: "" }));
  await user.click(screen.getByRole("button", { name: "Supprimer les identifiants" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "Êtes-vous sûr de vouloir supprimer ces identifiants de connexion ?",
  );
  const before = bodies.length;
  await user.click(screen.getByRole("button", { name: "Annuler" }));
  expect(bodies).toHaveLength(before);
  await user.click(screen.getByRole("button", { name: "Supprimer les identifiants" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Supprimer" }),
  );
  await waitFor(() => expect(bodies.at(-1)).toEqual({ clearCredentials: true }));
  expect(screen.queryByText(/formulaire à configurer/)).not.toBeInTheDocument();
});

test("clears an unsaved password when closing the access modal with Escape", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Activer www.lemonde.fr" }));
  const trigger = screen.getAllByRole("button", { name: "Configurer l'accès" })[0]!;
  await user.click(trigger);
  expect(screen.getByLabelText("Email pour www.lemonde.fr")).toHaveFocus();
  await user.type(screen.getByLabelText("Mot de passe", { exact: true }), "unsaved-secret");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(bodies).toEqual([{ enabled: true }]);
  await user.click(trigger);
  expect(screen.getByLabelText("Mot de passe", { exact: true })).toHaveValue("");
});
