import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Plus, Globe, Rss } from "lucide-react";
import { Tabs } from "radix-ui";
import type { SourcePage, SourceListQuery } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { SourceList } from "@/sources/SourceList";
import { sourcesApi } from "@/sources/api";
import { errorMessage } from "@/lib/api";

export function SourcesPage() {
  const [data, setData] = useState<{ result: SourcePage; key: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [params, setParams] = useSearchParams();
  const type: NonNullable<SourceListQuery["type"]> =
    params.get("type") === "scraping" ? "SCRAPING" : "RSS";
  const query = params.get("q") ?? "";
  const status: NonNullable<SourceListQuery["status"]> =
    params.get("status") === "active"
      ? "active"
      : params.get("status") === "inactive"
        ? "inactive"
        : "all";
  const requestedPage = Number(params.get("page") ?? 1);
  const page =
    Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 1000000
      ? requestedPage
      : 1;
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim());
  const searchPending = query.trim() !== debouncedQuery;
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const key = JSON.stringify({ type, status, query: debouncedQuery, page });
  const criteria = useRef({ type, status, query: debouncedQuery, page, key });
  criteria.current = { type, status, query: debouncedQuery, page, key };
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    if (!mounted.current) return;
    const id = ++requestId.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = criteria.current;
    setLoading(true);
    setError("");
    try {
      const result = await sourcesApi.list(current, request.signal);
      if (mounted.current && id === requestId.current && !request.signal.aborted)
        setData({ result, key: current.key });
    } catch (error) {
      if (mounted.current && id === requestId.current && !request.signal.aborted) {
        setError(errorMessage(error));
        throw error;
      }
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!searchPending) void refresh().catch(() => {});
    return () => {
      requestId.current++;
      controller.current?.abort();
    };
  }, [refresh, key, searchPending]);
  const result = data?.key === key ? data.result : null;
  function changeFilter(name: "q" | "status", value: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("page");
        if (!value || (name === "status" && value === "all")) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: name === "q" },
    );
  }
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
          next.delete("page");
          next.delete("q");
          next.delete("status");
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
          {!data && loading ? (
            <p role="status">Chargement des sources…</p>
          ) : (
            data && (
              <SourceList
                key={type}
                sources={result?.sources ?? []}
                pagination={result ?? { total: 0, page: 1, pageSize: 5 }}
                loading={loading || searchPending}
                controls={{
                  query,
                  status,
                  onQueryChange: (value) => changeFilter("q", value),
                  onStatusChange: (value) => changeFilter("status", value),
                  onPageChange: (value) =>
                    setParams((previous) => {
                      const next = new URLSearchParams(previous);
                      next.set("page", String(value));
                      return next;
                    }),
                }}
                onChanged={refresh}
              />
            )
          )}
          {data && (loading || searchPending) && <p role="status">Chargement des sources…</p>}
        </Tabs.Content>
      </Tabs.Root>
    </main>
  );
}
