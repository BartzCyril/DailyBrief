import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { test, expect } from "vitest";
import { Feedback } from "../components/Feedback";
import { NavigationFeedback } from "../components/NavigationFeedback";

test("shows one notification after StrictMode replay, outside the form, and supports keyboard dismissal", async () => {
  const view = render(
    <StrictMode>
      <form aria-label="Réglages">
        <Feedback message="Réglages enregistrés." />
      </form>
    </StrictMode>,
  );
  const message = await screen.findByText("Réglages enregistrés.");
  expect(within(screen.getByRole("form")).queryByText("Réglages enregistrés.")).toBeNull();
  expect(message.closest("[data-sonner-toast]")).toHaveAttribute("data-type", "success");
  view.rerender(
    <StrictMode>
      <form aria-label="Réglages">
        <Feedback message="Réglages enregistrés." />
      </form>
    </StrictMode>,
  );
  expect(screen.getAllByText("Réglages enregistrés.")).toHaveLength(1);
  screen.getByRole("button", { name: "Fermer la notification" }).focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByText("Réglages enregistrés.")).toBeNull());
});

test("announces errors and updates the notification instead of accumulating obsolete messages", async () => {
  const view = render(<Feedback error message="Enregistrement impossible." />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Enregistrement impossible.");
  view.rerender(<Feedback error message="Le site est indisponible." />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Le site est indisponible."),
  );
  expect(screen.queryByText("Enregistrement impossible.")).toBeNull();
  view.rerender(<Feedback error message="" />);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("keeps a fast retry notification after the previous toast finishes dismissing", async () => {
  const view = render(<Feedback error message="Analyse impossible." />);
  await screen.findByText("Analyse impossible.");
  view.rerender(<Feedback error message="" />);
  view.rerender(<Feedback error message="Envoi impossible. Réessayez." />);
  await screen.findByText("Envoi impossible. Réessayez.");
  await waitFor(() => expect(screen.queryByText("Analyse impossible.")).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Envoi impossible. Réessayez.");
});

test("consumes redirect feedback so going back does not announce the same success again", async () => {
  function Page() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <>
        <NavigationFeedback />
        <p>{location.pathname}</p>
        <output aria-label="État de navigation">{JSON.stringify(location.state)}</output>
        <button onClick={() => navigate("/journals")}>Journaux</button>
        <button onClick={() => navigate(-1)}>Retour</button>
      </>
    );
  }
  render(
    <MemoryRouter
      initialEntries={[{ pathname: "/sources", state: { message: "Source ajoutée." } }]}
    >
      <Page />
    </MemoryRouter>,
  );
  await screen.findByText("Source ajoutée.");
  expect(screen.getByLabelText("État de navigation")).toHaveTextContent("null");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Fermer la notification" }));
  await waitFor(() => expect(screen.queryByText("Source ajoutée.")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Journaux" }));
  await user.click(screen.getByRole("button", { name: "Retour" }));
  expect(screen.getByText("/sources")).toBeInTheDocument();
  expect(screen.queryByText("Source ajoutée.")).toBeNull();
});
