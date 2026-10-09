import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Plus, Globe } from "lucide-react";
import type { Source } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { SourceList } from "@/sources/SourceList";
import { sourcesApi } from "@/sources/api";
import { errorMessage } from "@/lib/api";

export function SourcesPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const location = useLocation();
  const notification: unknown = location.state;
  const message =
    notification &&
    typeof notification === "object" &&
    "message" in notification &&
    typeof notification.message === "string"
      ? notification.message
      : "";
  const refresh = useCallback(async () => {
    setError("");
    try {
      setSources(await sourcesApi.list());
    } catch (error) {
      setError(errorMessage(error));
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  return (
    <main className="mx-auto max-w-6xl space-y-7 px-5 py-9">
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="space-y-2">
          <h1 tabIndex={-1} className="text-3xl font-semibold">
            Sources
          </h1>
          <p className="text-muted-foreground">
            Ajoutez et configurez les flux RSS et les sites qui composent votre veille.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/sources/new/rss">
              <Plus />
              Ajouter un flux RSS
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/sources/new/scraping">
              <Globe />
              Ajouter une source de scraping
            </Link>
          </Button>
        </div>
      </div>
      <Feedback message={message} />
      <Feedback error message={error} />
      {error && (
        <Button variant="outline" onClick={() => void refresh().catch(() => {})}>
          Réessayer
        </Button>
      )}
      {loading ? (
        <p role="status">Chargement des sources…</p>
      ) : (
        sources && <SourceList sources={sources} onChanged={refresh} />
      )}
    </main>
  );
}
