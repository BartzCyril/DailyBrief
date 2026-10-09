import type { Source, ScrapingConfig } from "@dailybrief/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Feedback } from "@/components/Feedback";
import { sourcesApi } from "./api";
import { errorMessage } from "@/lib/api";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2 } from "lucide-react";
import { EditSourceForm } from "./EditSourceForm";
import { Modal } from "@/components/Modal";
import { ConfirmDelete } from "@/components/ConfirmDelete";
export function SourceList({
  sources,
  onChanged,
}: {
  sources: Source[];
  onChanged?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState("");
  const [message, setMessage] = useState("");
  async function remove(source: Source) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.remove(source.id);
      await onChanged?.();
      setEditingId((previous) => (previous === source.id ? "" : previous));
      setMessage("Source supprimée.");
    } finally {
      setBusy("");
    }
  }
  async function updateSource(
    source: Source,
    url: string,
    config?: ScrapingConfig,
    articleLinkSelector?: string | null,
  ) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.update(source.id, url, config, articleLinkSelector);
      await onChanged?.();
      setEditingId("");
      setMessage("Source modifiée.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  async function toggle(source: Source, enabled: boolean) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.setEnabled(source.id, enabled);
      await onChanged?.();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="space-y-5">
      <Feedback message={editingId ? "" : error} error />
      <Feedback message={message} />
      {sources.length ? (
        sources.map((source) => (
          <Card className="shadow-none" key={source.id}>
            <CardContent className="flex flex-wrap items-center gap-4 py-5">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                <p className="text-sm break-all">{source.url}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Badge variant="secondary">{source.type}</Badge>
                  {source.scrapingConfig?.mode && (
                    <Badge variant="outline">
                      {source.scrapingConfig.mode === "LOAD_MORE"
                        ? "Bouton charger plus"
                        : source.scrapingConfig.mode}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {source.enabled ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/sources/${source.id}/workflow`}>Tester le workflow de A à Z</Link>
              </Button>
              {onChanged && (
                <div className="flex items-center gap-3">
                  <Modal
                    open={editingId === source.id}
                    onOpenChange={(open) => {
                      setEditingId(open ? source.id : "");
                      setError("");
                      setMessage("");
                    }}
                    busy={!!busy}
                    title={
                      source.type === "RSS"
                        ? "Modifier le flux RSS"
                        : "Modifier la source de scraping"
                    }
                    description={source.url}
                    trigger={
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="cursor-pointer"
                        disabled={!!busy}
                        aria-label={`Modifier ${source.url}`}
                        title="Modifier la source"
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                    }
                  >
                    <EditSourceForm
                      key={source.id}
                      source={source}
                      busy={!!busy}
                      onSave={(url, config, articleLinkSelector) =>
                        updateSource(source, url, config, articleLinkSelector)
                      }
                      onCancel={() => {
                        setEditingId("");
                        setError("");
                      }}
                    />
                    <div className="mt-4">
                      <Feedback message={error} error />
                    </div>
                  </Modal>
                  <ConfirmDelete
                    itemType={source.type === "RSS" ? "ce flux RSS" : "cette source de scraping"}
                    description={`${source.url} — Les articles et résumés associés seront également supprimés.`}
                    onConfirm={() => remove(source)}
                    trigger={
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="cursor-pointer text-destructive hover:text-destructive"
                        disabled={!!busy}
                        aria-label={`Supprimer ${source.url}`}
                        title="Supprimer la source"
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    }
                  />
                  <Switch
                    className="cursor-pointer"
                    title={source.enabled ? "Désactiver la source" : "Activer la source"}
                    aria-label={`Activer ${source.url}`}
                    checked={source.enabled}
                    disabled={!!busy}
                    onCheckedChange={(enabled) => void toggle(source, enabled)}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        ))
      ) : (
        <p className="py-8 text-sm text-muted-foreground">
          Aucune source configurée. Ajoutez votre premier flux RSS ou votre première source de
          scraping.
        </p>
      )}
    </div>
  );
}
