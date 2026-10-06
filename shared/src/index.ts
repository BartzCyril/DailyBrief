export type User = { id: string; email: string };
export type ArticlePreview = { title: string; url: string | null; publishedAt: string | null; description: string | null; content?: string | null; guid?: string | null };
export type Source = { id: string; url: string; type: "RSS" | "SCRAPING"; enabled: boolean; scrapingConfig: ScrapingConfig | null };
export type ScrapingConfig = {
  articleSelector: string; titleSelector: string; linkSelector: string;
  descriptionSelector?: string | null; dateSelector?: string | null;
  mode: "SCROLL" | "PAGINATE";
  scroll?: { maxScrolls: number; waitAfterScrollMs: number };
  pagination?: { strategy: "URL_TEMPLATE" | "QUERY_PARAM"; maxPages: number; startPage: number; urlTemplate?: string; queryParam?: string };
};
export type SourcePreview = { feed?: { title: string; url: string }; mode?: string; articles: ArticlePreview[] };
