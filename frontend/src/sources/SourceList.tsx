import type { Source } from "@dailybrief/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
export function SourceList({ sources }: { sources: Source[] }) {
  return sources.length ? <div className="space-y-3">{sources.map(source => <Card className="shadow-none" key={source.id}><CardContent className="flex flex-wrap items-center gap-3 py-4"><div className="min-w-0 flex-1"><p className="text-sm break-all">{source.url}</p><div className="mt-2 flex gap-2"><Badge variant="secondary">{source.type}</Badge>{source.scrapingConfig?.mode && <Badge variant="outline">{source.scrapingConfig.mode}</Badge>}<span className="text-xs text-muted-foreground">{source.enabled ? "Active" : "Inactive"}</span></div></div></CardContent></Card>)}</div> : <p className="py-8 text-sm text-muted-foreground">Aucune source configurée. Ajoutez votre premier flux RSS ou votre première source de scraping.</p>;
}
