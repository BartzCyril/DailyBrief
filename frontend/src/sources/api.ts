import type { Source, SourcePreview, ScrapingConfig } from "@dailybrief/shared";
import { api } from "@/lib/api";
export const sourcesApi = {
  list: () => api<Source[]>("/sources"),
  testRss: (url: string) =>
    api<SourcePreview>("/sources/rss/test", { method: "POST", body: { url } }),
  saveRss: (url: string) => api<Source>("/sources", { method: "POST", body: { url, type: "RSS" } }),
  testScraping: (url: string, config: ScrapingConfig) =>
    api<SourcePreview>("/sources/scraping/test", { method: "POST", body: { url, config } }),
  saveScraping: (url: string, scrapingConfig: ScrapingConfig) =>
    api<Source>("/sources", { method: "POST", body: { url, type: "SCRAPING", scrapingConfig } }),
  setEnabled: (id: string, enabled: boolean) =>
    api<void>(`/sources/${id}`, { method: "PATCH", body: { enabled } }),
};
export function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
