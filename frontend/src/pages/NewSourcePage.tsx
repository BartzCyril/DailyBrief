import { SourceFormPage } from "@/sources/SourceFormPage";
import { RssForm } from "@/sources/RssForm";
import { ScrapingForm } from "@/sources/ScrapingForm";
export function NewSourcePage({ scraping = false }: { scraping?: boolean }) {
  return (
    <SourceFormPage scraping={scraping}>{scraping ? <ScrapingForm /> : <RssForm />}</SourceFormPage>
  );
}
