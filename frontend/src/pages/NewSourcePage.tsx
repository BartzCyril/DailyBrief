import { Link } from "react-router-dom";
import { Card, CardHeader, CardContent, CardDescription } from "@/components/ui/card";
import { RssForm } from "@/sources/RssForm";
import { ScrapingForm } from "@/sources/ScrapingForm";
export function NewSourcePage({ scraping = false }: { scraping?: boolean }) {
  return (
    <main className="max-w-3xl mx-auto px-5 py-8 space-y-6">
      <Link
        to={scraping ? "/sources?type=scraping" : "/sources"}
        className="text-sm text-primary underline"
      >
        ← Retour aux sources
      </Link>
      <Card>
        <CardHeader>
          <h1 tabIndex={-1} className="text-2xl font-semibold">
            {scraping ? "Ajouter une source de scraping" : "Ajouter un flux RSS"}
          </h1>
          <CardDescription>
            {scraping
              ? "Choisissez les éléments à extraire, puis vérifiez le résultat."
              : "Testez le flux pour vérifier les articles avant de l'enregistrer."}
          </CardDescription>
        </CardHeader>
        <CardContent>{scraping ? <ScrapingForm /> : <RssForm />}</CardContent>
      </Card>
    </main>
  );
}
