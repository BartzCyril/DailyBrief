import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { SourcesSection } from "@/sources/SourcesSection";
export function DashboardPage() { const auth = useAuth(); return <main className="max-w-5xl mx-auto p-8"><h1>Votre DailyBrief</h1><p>{auth.user?.email}</p><Button onClick={() => void auth.logout()}>Se déconnecter</Button><SourcesSection/></main>; }
