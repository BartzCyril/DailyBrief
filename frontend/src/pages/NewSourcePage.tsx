import { Link } from "react-router-dom";
import { Card, CardHeader, CardContent, CardDescription } from "@/components/ui/card";
import { RssForm } from "@/sources/RssForm";
import { ScrapingForm } from "@/sources/ScrapingForm";
export function NewSourcePage({ scraping = false }: { scraping?: boolean }) {
  return (
    <main id="app-content" tabIndex={-1} className="app-page app-page-form">
      <div className="flex flex-wrap justify-between gap-4">
        <Link
          to={scraping ? "/sources?type=scraping" : "/sources"}
          className="text-sm text-primary underline"
        >
          ← Retour aux sources
        </Link>
        <Link
          className="text-sm text-primary underline"
          to={scraping ? "/documentation#scraping" : "/documentation#rss"}
        >
          Aide à la configuration ↗
        </Link>
      </div>
      <Card>
        <CardHeader>
          <h1 tabIndex={-1} className="app-page-title">
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
