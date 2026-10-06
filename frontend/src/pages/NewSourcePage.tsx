import { Link } from "react-router-dom";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { RssForm } from "@/sources/RssForm";
export function NewSourcePage() { return <main className="max-w-3xl mx-auto px-5 py-8 space-y-6"><Link to="/dashboard" className="text-sm text-primary underline">← Retour au dashboard</Link><Card><CardHeader><CardTitle className="text-2xl">Ajouter un flux RSS</CardTitle><CardDescription>Testez le flux pour vérifier les articles avant de l'enregistrer.</CardDescription></CardHeader><CardContent><RssForm/></CardContent></Card></main>; }
