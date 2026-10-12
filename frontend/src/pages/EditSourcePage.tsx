import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { Source, ScrapingConfig } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { errorMessage } from "@/lib/api";
import { SourceFormPage } from "@/sources/SourceFormPage";
import { EditSourceForm } from "@/sources/EditSourceForm";
import { sourcesApi } from "@/sources/api";

export function EditSourcePage({ scraping = false }: { scraping?: boolean }) {
  const { sourceId = "" } = useParams();
  const navigate = useNavigate();
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setSource(null);
    setError("");
    setBusy(false);
    void sourcesApi.get(sourceId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setSource(value);
          setLoading(false);
        }
      },
      (error) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [sourceId, reload]);

  const current = source?.id === sourceId ? source : null;
  if (current && (current.type === "SCRAPING") !== scraping)
    return (
      <Navigate
        to={`/sources/edit/${current.type.toLowerCase()}/${encodeURIComponent(current.id)}`}
        replace
      />
    );

  async function save(url: string, config?: ScrapingConfig, articleLinkSelector?: string | null) {
    if (!current || busy) return;
    const request = active.current;
    setBusy(true);
    setError("");
    try {
      await sourcesApi.update(current.id, url, config, articleLinkSelector);
      if (!request?.signal.aborted)
        navigate(scraping ? "/sources?type=scraping" : "/sources", {
          state: { message: "Source modifiée." },
        });
    } catch (error) {
      if (!request?.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!request?.signal.aborted) setBusy(false);
    }
  }

  return (
    <SourceFormPage scraping={scraping} editing>
      {loading ? (
        <p role="status">Chargement de la source…</p>
      ) : current ? (
        <EditSourceForm
          key={current.id}
          source={current}
          busy={busy}
          onSave={save}
          onCancel={() => navigate(scraping ? "/sources?type=scraping" : "/sources")}
        />
      ) : (
        <div className="space-y-4">
          <p>Impossible de charger cette source.</p>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            Réessayer
          </Button>
        </div>
      )}
      <Feedback error message={error} />
    </SourceFormPage>
  );
}
