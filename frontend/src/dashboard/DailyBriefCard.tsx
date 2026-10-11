import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarDays, Sparkles } from "lucide-react";
import type { DailyBriefSnapshot } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { BriefArticlesDialog } from "./BriefArticlesDialog";

function briefDate(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function DailyBriefCard({
  brief,
  hasSources,
}: {
  brief?: DailyBriefSnapshot | null;
  hasSources: boolean;
}) {
  const content = brief?.status === "READY" ? brief.content : null;
  return (
    <section className="daily-brief" aria-label="Dernier Daily Brief">
      <div className="daily-brief-header">
        <span className="daily-brief-label">
          <Sparkles className="size-4" aria-hidden="true" />
          Votre revue quotidienne
        </span>
        {brief && (
          <span className="daily-brief-date">
            <CalendarDays className="size-4" aria-hidden="true" />
            <time dateTime={brief.date}>{briefDate(brief.date)}</time>
          </span>
        )}
      </div>
      <div className="daily-brief-body">
        {content ? (
          <>
            <div className="daily-brief-intro">
              <h2>{content.headline}</h2>
              <p className="daily-brief-lead">{content.lead}</p>
            </div>
            {!!content.stories.length && (
              <section aria-labelledby="daily-brief-stories" className="daily-brief-section">
                <h3 id="daily-brief-stories">À retenir aujourd’hui</h3>
                <ol className="daily-brief-stories">
                  {content.stories.map((story, index) => (
                    <li key={index} className="daily-brief-story">
                      <span className="daily-brief-number" aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h4>{story.title}</h4>
                        <p>{story.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {!!content.otherNews.length && (
              <section aria-labelledby="daily-brief-other" className="daily-brief-section">
                <h3 id="daily-brief-other">Autres informations intéressantes</h3>
                <ul className="daily-brief-other">
                  {content.otherNews.map((story, index) => (
                    <li key={index}>
                      <h4>{story.title}</h4>
                      <p>{story.text}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {content.trends && (
              <section aria-labelledby="daily-brief-trends" className="daily-brief-trends">
                <h3 id="daily-brief-trends">Tendances du jour</h3>
                <p>{content.trends}</p>
              </section>
            )}
          </>
        ) : (
          <div className="daily-brief-intro">
            <h2>
              {brief?.status === "FAILED"
                ? "Cette édition n’a pas pu être préparée."
                : brief?.status === "EMPTY"
                  ? "Aucune actualité à retenir pour cette édition."
                  : "L’essentiel, chaque jour."}
            </h2>
            <p className="daily-brief-lead">
              {brief?.status === "FAILED"
                ? (brief.error ??
                  "Les résumés disponibles restent consultables dans l’historique d’exécutions.")
                : brief?.status === "EMPTY"
                  ? "Aucun article récent et pertinent n’était disponible. Votre prochaine récupération préparera une nouvelle édition."
                  : hasSources
                    ? "Lancez une récupération pour découvrir votre première revue : les sujets importants, regroupés et expliqués en quelques minutes."
                    : "Ajoutez vos sources pour recevoir une revue des sujets importants, regroupés et expliqués en quelques minutes."}
            </p>
            {!brief && !hasSources && (
              <Button asChild className="mt-5">
                <Link to="/sources">Configurer mes sources</Link>
              </Button>
            )}
          </div>
        )}
        {brief && (
          <footer className="daily-brief-footer">
            <p>
              {brief.articleCount} article{brief.articleCount > 1 ? "s" : ""} pertinent
              {brief.articleCount > 1 ? "s" : ""}
            </p>
            {content ? (
              <BriefArticlesDialog briefId={brief.id} timezone={brief.timezone} />
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link to={`/jobs?run=${encodeURIComponent(brief.runId)}`}>
                  Voir l’historique d’exécutions
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </Button>
            )}
          </footer>
        )}
      </div>
    </section>
  );
}
