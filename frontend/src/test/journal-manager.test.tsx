import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JournalPreview } from "@dailybrief/shared";
import { JournalManager } from "../dashboard/JournalManager";

let journals: JournalPreview[];
let failLoad = false,
  failDelete = false;
const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/journals" && init?.method === "GET")
    return new Response(
      JSON.stringify(
        failLoad
          ? { message: "Journaux indisponibles" }
          : { journals, lastInventoriedAt: "2026-10-09T17:00:00Z", unresolvedCount: 1 },
      ),
      { status: failLoad ? 503 : 200 },
    );
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (init?.method === "POST") {
    const journal = {
      domain: body.domain.toLowerCase(),
      count: 0,
      enabled: false,
      email: null,
      hasCredentials: false,
      authenticationSupported: false,
      loginConfig: null,
    };
    journals = [...journals, journal];
    return new Response(JSON.stringify(journal), { status: 201 });
  }
  const previous = journals.find((journal) => url.endsWith(`/${journal.domain}`))!;
  if (init?.method === "DELETE") {
    if (failDelete)
      return new Response(JSON.stringify({ message: "Suppression impossible" }), { status: 500 });
    journals = journals.filter((journal) => journal.domain !== previous.domain);
    return new Response(null, { status: 204 });
  }
  const saved = body.domain
    ? {
        ...previous,
        domain: body.domain,
        count: 0,
        enabled: false,
        email: null,
        hasCredentials: false,
        loginConfig: null,
        authenticationSupported: false,
      }
    : { ...previous, ...body };
  journals = journals.map((journal) => (journal === previous ? saved : journal));
  return new Response(JSON.stringify(saved));
});
beforeEach(() => {
  journals = [
    {
      domain: "paper.example",
      count: 4,
      enabled: false,
      email: null,
      hasCredentials: false,
      authenticationSupported: false,
    },
  ];
  failLoad = failDelete = false;
  fetcher.mockClear();
  vi.stubGlobal("fetch", fetcher);
});

test("shows saved journal counts and supports keyboard addition, activation, renaming and deletion", async () => {
  const user = userEvent.setup();
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<JournalManager />);
  const link = await screen.findByRole("link", { name: "paper.example" });
  expect(within(link.closest("tr")!).getByText("4")).toBeInTheDocument();
  expect(screen.getByText(/1 notice non résolue/)).toBeInTheDocument();
  screen.getByRole("button", { name: "Ajouter un journal" }).focus();
  await user.keyboard("{Enter}");
  await user.type(screen.getByLabelText("Domaine du nouveau journal"), "MANUAL.EXAMPLE");
  await user.click(screen.getByRole("button", { name: "Enregistrer le journal" }));
  expect(await screen.findByRole("button", { name: "Activer manual.example" })).toBeInTheDocument();
  const create = fetcher.mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(create?.[1]?.body))).toEqual({ domain: "MANUAL.EXAMPLE" });
  await user.click(screen.getByRole("button", { name: "Activer manual.example" }));
  expect(
    await screen.findByRole("button", { name: "Désactiver manual.example" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Modifier le domaine manual.example" }));
  expect(screen.getByText(/Changer de domaine désactive le journal/)).toBeInTheDocument();
  await user.clear(screen.getByLabelText("Nouveau domaine pour manual.example"));
  await user.type(
    screen.getByLabelText("Nouveau domaine pour manual.example"),
    "corrected.example",
  );
  await user.click(screen.getByRole("button", { name: "Enregistrer le domaine" }));
  expect(
    await screen.findByRole("button", { name: "Activer corrected.example" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "manual.example" })).not.toBeInTheDocument();
  const remove = screen.getByRole("button", { name: "Supprimer le journal corrected.example" });
  await user.click(remove);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  confirmation.mockReturnValue(true);
  await user.click(remove);
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "corrected.example" })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("link", { name: "paper.example" })).toBeInTheDocument();
  confirmation.mockRestore();
});

test("keeps a journal visible after a deletion error and allows list loading to be retried", async () => {
  const user = userEvent.setup();
  failLoad = true;
  render(<JournalManager />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Journaux indisponibles");
  failLoad = false;
  await user.click(screen.getByRole("button", { name: "Actualiser les journaux" }));
  await screen.findByRole("link", { name: "paper.example" });
  failDelete = true;
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Supprimer le journal paper.example" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Suppression impossible");
  expect(screen.getByRole("link", { name: "paper.example" })).toBeInTheDocument();
  confirmation.mockRestore();
});

test("refreshes recorded counts after collection without accepting a late obsolete response", async () => {
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementation(fetcher),
  );
  const { rerender } = render(<JournalManager refreshKey={0} />);
  rerender(<JournalManager refreshKey={1} />);
  await screen.findByRole("link", { name: "paper.example" });
  resolveOld(
    new Response(JSON.stringify({ journals: [], lastInventoriedAt: null, unresolvedCount: 0 })),
  );
  await waitFor(() =>
    expect(screen.queryByText("Chargement des journaux…")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("link", { name: "paper.example" })).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith(
    "/api/journals",
    expect.objectContaining({ method: "GET", credentials: "include" }),
  );
});
