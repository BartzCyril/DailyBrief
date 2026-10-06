import { useEffect, useState } from "react";
import type { Source } from "@dailybrief/shared";
import { Link } from "react-router-dom";
import { sourcesApi } from "./api";
import { SourceList } from "./SourceList";
import { errorMessage } from "@/lib/api";
import { Feedback } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
export function SourcesSection() {
  const [sources, setSources] = useState<Source[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  useEffect(() => { let active = true; void sourcesApi.list().then(sources => { if (active) setSources(sources); }).catch(error => { if (active) setError(errorMessage(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  return <section className="space-y-4 mt-8"><div className="flex flex-wrap justify-between items-center gap-3"><h2 className="text-xl font-semibold">Vos sources</h2><Button asChild><Link to="/sources/new/rss">Ajouter un flux RSS</Link></Button></div><Feedback message={error} error/>{loading ? <p role="status">Chargement des sources…</p> : <SourceList sources={sources}/>}</section>;
}
