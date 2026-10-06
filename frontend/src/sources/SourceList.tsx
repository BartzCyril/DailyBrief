import type { Source } from "@dailybrief/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Feedback } from "@/components/Feedback";
import { sourcesApi } from "./api";
import { errorMessage } from "@/lib/api";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
export function SourceList({
  sources,
  onChanged,
}: {
  sources: Source[];
  onChanged?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function toggle(source: Source, enabled: boolean) {
    if (busy) return;
    setBusy(source.id);
    setError("");
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
      {sources.length ? (
        sources.map((source) => (
          <Card className="shadow-none" key={source.id}>
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm break-all">{source.url}</p>
                <div className="mt-2 flex gap-2">
                  <Badge variant="secondary">{source.type}</Badge>
                  {source.scrapingConfig?.mode && (
                    <Badge variant="outline">{source.scrapingConfig.mode}</Badge>
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
                <Switch
                  aria-label={`Activer ${source.url}`}
                  checked={source.enabled}
                  disabled={!!busy}
                  onCheckedChange={(enabled) => void toggle(source, enabled)}
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
