import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Plus, Globe, Rss } from "lucide-react";
import { Tabs } from "radix-ui";
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
  const [params, setParams] = useSearchParams();
  const type = params.get("type") === "scraping" ? "SCRAPING" : "RSS";
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
        </div>
        <Button asChild>
          <Link to={type === "RSS" ? "/sources/new/rss" : "/sources/new/scraping"}>
            <Plus aria-hidden="true" />
            {type === "RSS" ? "Ajouter un flux RSS" : "Ajouter une source de scraping"}
          </Link>
        </Button>
      </div>
      <Feedback message={message} />
      <Feedback error message={error} />
      {error && (
        <Button variant="outline" onClick={() => void refresh().catch(() => {})}>
          Réessayer
        </Button>
      )}
      <Tabs.Root
        value={type}
        onValueChange={(value) => {
          const next = new URLSearchParams(params);
          if (value === "SCRAPING") next.set("type", "scraping");
          else next.delete("type");
          setParams(next);
        }}
        className="space-y-6"
      >
        <Tabs.List
          aria-label="Type de sources"
          className="inline-flex gap-2 rounded-lg bg-muted p-1"
        >
          {(["RSS", "SCRAPING"] as const).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="flex cursor-pointer items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              {value === "RSS" ? (
                <Rss className="size-4" aria-hidden="true" />
              ) : (
                <Globe className="size-4" aria-hidden="true" />
              )}
              {value}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content
          value={type}
          className="space-y-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {loading ? (
            <p role="status">Chargement des sources…</p>
          ) : (
            sources && (
              <SourceList
                key={type}
                sources={sources.filter((source) => source.type === type)}
                onChanged={refresh}
              />
            )
          )}
        </Tabs.Content>
      </Tabs.Root>
    </main>
  );
}
