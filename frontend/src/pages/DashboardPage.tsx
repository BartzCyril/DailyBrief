import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
export function DashboardPage() { const auth = useAuth(); return <main className="p-8"><h1>Votre DailyBrief</h1><p>{auth.user?.email}</p><Button onClick={() => void auth.logout()}>Se déconnecter</Button></main>; }
