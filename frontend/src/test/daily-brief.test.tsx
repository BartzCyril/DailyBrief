import { expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DailyBriefSnapshot } from "@dailybrief/shared";
import { DailyBriefCard } from "../dashboard/DailyBriefCard";

const brief: DailyBriefSnapshot = {
  id: "brief-1",
  runId: "run-1",
  date: "2026-10-11",
  timezone: "Europe/Paris",
  status: "READY",
  articleCount: 3,
  createdAt: "2026-10-11T07:35:00Z",
  error: null,
  content: {
    headline: "Les nouveautés qui changent le développement web",
    lead: "React et l’IA font avancer les outils du quotidien.",
    stories: [
      {
        title: "Une nouvelle version de React",
        text: "Deux articles éclairent le même sujet.\nUne synthèse suffit pour comprendre.",
        articleIds: ["a1", "a2"],
      },
    ],
    otherNews: [
      { title: "Un outil à découvrir", text: "Une actualité secondaire.", articleIds: ["a3"] },
    ],
    trends: "Les outils de développement intègrent davantage l’IA.",
  },
};

function mount(value?: DailyBriefSnapshot | null, hasSources = true) {
  render(
    <MemoryRouter>
      <DailyBriefCard brief={value} hasSources={hasSources} />
    </MemoryRouter>,
  );
}

test("shows the structured daily edition and offers its individual summaries", () => {
  mount(brief);
  const card = screen.getByRole("region", { name: "Dernier Daily Brief" });
  expect(within(card).getByRole("heading", { name: brief.content!.headline })).toBeInTheDocument();
  expect(screen.getByText("11 octobre 2026").closest("time")).toHaveAttribute(
    "dateTime",
    "2026-10-11",
  );
  expect(screen.getByRole("heading", { name: "À retenir aujourd’hui" })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Autres informations intéressantes" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Tendances du jour" })).toBeInTheDocument();
  expect(screen.getByText("3 articles pertinents")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Lire les résumés individuels" })).toBeInTheDocument();
});

test("does not invent secondary stories and treats AI content as plain text", () => {
  mount({
    ...brief,
    content: {
      ...brief.content!,
      headline: "<img src=x onerror=alert(1)>",
      otherNews: [],
      trends: "",
    },
  });
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Autres informations intéressantes" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Tendances du jour" })).toBeNull();
});

test("explains the first edition and directs users without active sources to configuration", () => {
  mount(null, false);
  expect(screen.getByRole("heading", { name: "L’essentiel, chaque jour." })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Configurer mes sources" })).toHaveAttribute(
    "href",
    "/sources",
  );
  expect(screen.queryByRole("link", { name: "Lire les résumés individuels" })).toBeNull();
});

test("shows an empty edition without pretending a brief was generated", () => {
  mount({ ...brief, status: "EMPTY", content: null, articleCount: 0 });
  expect(
    screen.getByRole("heading", { name: "Aucune actualité à retenir pour cette édition." }),
  ).toBeInTheDocument();
  expect(screen.getByText("0 article pertinent")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Voir l’historique d’exécutions" })).toHaveAttribute(
    "href",
    "/jobs?run=run-1",
  );
});

test("keeps individual summaries reachable when the final brief fails", () => {
  mount({ ...brief, status: "FAILED", content: null, error: "Le modèle IA est indisponible." });
  expect(screen.getByText("Le modèle IA est indisponible.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Voir l’historique d’exécutions" })).toHaveAttribute(
    "href",
    "/jobs?run=run-1",
  );
});
