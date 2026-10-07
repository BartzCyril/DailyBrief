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
    if (
      busy ||
      !window.confirm(
        `Supprimer la source ${source.url} ?\n\nLes articles et résumés associés seront également supprimés.`,
      )
    )
      return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.remove(source.id);
      await onChanged?.();
      setEditingId((previous) => (previous === source.id ? "" : previous));
      setMessage("Source supprimée.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  async function updateSource(source: Source, url: string, config?: ScrapingConfig) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.update(source.id, url, config);
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
    <div className="space-y-3">
      <Feedback message={error} error />
      <Feedback message={message} />
      {sources.length ? (
        sources.map((source) => (
          <Card className="shadow-none" key={source.id}>
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                <p className="text-sm break-all">{source.url}</p>
                <div className="mt-2 flex gap-2">
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
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="cursor-pointer"
                    disabled={!!busy}
                    onClick={() => {
                      setEditingId(source.id);
                      setError("");
                      setMessage("");
                    }}
                    aria-label={`Modifier ${source.url}`}
                    title="Modifier la source"
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="cursor-pointer text-destructive hover:text-destructive"
                    disabled={!!busy}
                    aria-label={`Supprimer ${source.url}`}
                    title="Supprimer la source"
                    onClick={() => void remove(source)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
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
              {editingId === source.id && (
                <EditSourceForm
                  key={source.id}
                  source={source}
                  busy={!!busy}
                  onSave={(url, config) => updateSource(source, url, config)}
                  onCancel={() => {
                    setEditingId("");
                    setError("");
                  }}
                />
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
