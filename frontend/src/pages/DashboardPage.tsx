import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Mail, LogOut, Plus, Globe } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Feedback } from "@/components/Feedback";
import { SourceList } from "@/sources/SourceList";
import { Statistics } from "@/dashboard/Statistics";
import { CollectionSettings } from "@/dashboard/CollectionSettings";
import { ManualCollection } from "@/dashboard/ManualCollection";
import { useDashboard } from "@/dashboard/useDashboard";
import { errorMessage } from "@/lib/api";
export function DashboardPage() {
  const auth = useAuth(); const dashboard = useDashboard(); const location = useLocation(); const [logoutError, setLogoutError] = useState(""); const [loggingOut, setLoggingOut] = useState(false);
  const notification: unknown = location.state;
  const message = notification && typeof notification === "object" && "message" in notification && typeof notification.message === "string" ? notification.message : "";
  async function logout() { setLoggingOut(true); try { await auth.logout(); } catch (error) { setLogoutError(errorMessage(error)); } finally { setLoggingOut(false); } }
  return <><header className="bg-card border-b"><div className="max-w-6xl mx-auto px-5 py-5 flex flex-wrap justify-between gap-4 items-center"><Link to="/dashboard" className="flex gap-2 items-center text-xl font-semibold"><Mail className="text-primary"/>DailyBrief</Link><div className="flex flex-wrap items-center gap-4"><span className="text-sm text-muted-foreground break-all">{auth.user?.email}</span><Button variant="ghost" onClick={() => void logout()} disabled={loggingOut}><LogOut/>{loggingOut ? "Déconnexion…" : "Se déconnecter"}</Button></div></div></header><main className="max-w-6xl mx-auto px-5 py-9 space-y-7"><div><p className="uppercase tracking-widest text-xs text-muted-foreground mb-2">Votre espace de veille</p><h1 className="text-3xl font-semibold">Votre DailyBrief</h1><p className="mt-2 text-muted-foreground">Vos sources, votre rythme, l'essentiel dans votre boîte mail.</p></div><Feedback error message={logoutError}/><Feedback message={message}/><Feedback error message={dashboard.error}/>{dashboard.error && <Button variant="outline" onClick={() => void dashboard.refresh()}>Réessayer</Button>}{dashboard.loading ? <div role="status" aria-label="Chargement du dashboard" className="grid sm:grid-cols-2 gap-4"><Skeleton className="h-36"/><Skeleton className="h-36"/></div> : dashboard.data && <><Statistics sources={dashboard.data.sources}/><section className="grid lg:grid-cols-[1.6fr_1fr] items-start gap-5"><CollectionSettings collection={dashboard.data.collection} onSaved={dashboard.refresh}/><ManualCollection onComplete={dashboard.refresh}/></section><section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-semibold">Vos sources</h2><p className="text-sm text-muted-foreground mt-1">Choisissez ce qui compose votre veille.</p></div><div className="flex flex-wrap gap-3"><Button asChild><Link to="/sources/new/rss"><Plus/>Ajouter un flux RSS</Link></Button><Button asChild variant="outline"><Link to="/sources/new/scraping"><Globe/>Ajouter une source de scraping</Link></Button></div></div><SourceList sources={dashboard.sources} onChanged={dashboard.refresh}/></section></>}</main></>;
}
