import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CardContent, CardDescription } from "@/components/ui/card";

export function SourceFormPage({
  scraping,
  editing = false,
  children,
}: {
  scraping: boolean;
  editing?: boolean;
  children: ReactNode;
}) {
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
            {scraping
              ? editing
                ? "Modifier la source de scraping"
                : "Ajouter une source de scraping"
              : editing
                ? "Modifier le flux RSS"
                : "Ajouter un flux RSS"}
          </h1>
          <CardDescription>
            {scraping
              ? "Choisissez les éléments à extraire, puis vérifiez le résultat."
              : "Testez le flux pour vérifier les articles avant de l'enregistrer."}
          </CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
