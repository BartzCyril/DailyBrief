export type User = { id: string; email: string };
export type ArticlePreview = {
  title: string;
  url: string | null;
  publishedAt: string | null;
  description: string | null;
  content?: string | null;
  guid?: string | null;
};
export type Source = {
  id: string;
  url: string;
  type: "RSS" | "SCRAPING";
  enabled: boolean;
  scrapingConfig: ScrapingConfig | null;
};
export type ScrapingConfig = {
  articleSelector: string;
  titleSelector: string;
  linkSelector: string;
  descriptionSelector?: string | null;
  dateSelector?: string | null;
  mode: "SCROLL" | "PAGINATE";
  scroll?: { maxScrolls: number; waitAfterScrollMs: number };
  pagination?: {
    strategy: "URL_TEMPLATE" | "QUERY_PARAM";
    maxPages: number;
    startPage: number;
    urlTemplate?: string;
    queryParam?: string;
  };
};
export type SourcePreview = {
  feed?: { title: string; url: string };
  mode?: string;
  articles: ArticlePreview[];
  warnings?: string[];
};
export type Dashboard = {
  sources: { total: number; rss: number; scraping: number; enabled: number };
  collection: {
    enabled: boolean;
    time: string;
    timezone: string;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
};
export type SettingsInput = {
  collectionEnabled: boolean;
  collectionTime: string;
  timezone: string;
};
export type RunResult = {
  status: "SENT" | "NO_NEW_ARTICLES" | "FAILED";
  sourcesProcessed: number;
  sourcesFailed: number;
  articlesCollected: number;
  newArticles: number;
  articlesSummarized: number;
  emailSent: boolean;
  newsletterId?: string;
  failure?: CollectionFailure;
};
export type CollectionStage = "collection" | "source" | "storage" | "ai" | "newsletter" | "email";
export type CollectionFailure = {
  stage: CollectionStage;
  code: string;
  message: string;
};
export type CollectionProgress = {
  stage: CollectionStage;
  status: "running" | "completed" | "failed" | "skipped";
  message: string;
  at: string;
  completed?: number;
  total?: number;
};
export type CollectionEvent =
  | { type: "progress"; progress: CollectionProgress }
  | { type: "result"; result: RunResult }
  | { type: "error"; message: string; code: string };
