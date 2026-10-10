export type User = { id: string; email: string };
export type {
  SelectorAnalysisKind,
  SelectorAnalysisInput,
  SelectorAnalysisResult,
  SelectorAnalysisResponse,
} from "./selector-assistance";
export type ArticlePreview = {
  title: string;
  url: string | null;
  publishedAt: string | null;
  description: string | null;
  content?: string | null;
  guid?: string | null;
  externalUrl?: string | null;
  journalDomain?: string;
  resolutionError?: string;
};
export type Source = {
  id: string;
  url: string;
  type: "RSS" | "SCRAPING";
  enabled: boolean;
  scrapingConfig: ScrapingConfig | null;
  articleLinkSelector?: string | null;
};
export type ScrapingConfig = {
  articleSelector: string;
  titleSelector: string;
  linkSelector: string;
  descriptionSelector?: string | null;
  dateSelector?: string | null;
  mode: "SCROLL" | "PAGINATE" | "LOAD_MORE";
  scroll?: { maxScrolls: number; waitAfterScrollMs: number };
  loadMore?: { buttonSelector: string; waitTimeoutMs: number };
  pagination?: {
    strategy: "URL_TEMPLATE" | "QUERY_PARAM";
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
export type CollectionStage =
  "collection" | "source" | "storage" | "content" | "ai" | "newsletter" | "email";
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
export type WorkflowPreview = {
  id: string;
  source: Pick<Source, "id" | "url" | "type">;
  articles: ArticlePreview[];
  warnings?: string[];
  expiresAt: string;
  journals?: JournalPreview[];
};
export type JournalAccess = {
  domain: string;
  enabled: boolean;
  email: string | null;
  hasCredentials: boolean;
  authenticationSupported: boolean;
  loginConfig?: JournalLoginConfig | null;
};
export type JournalLoginConfig = {
  loginUrl: string;
  emailSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successSelector: string;
  articleContentSelector?: string | null;
};
export type JournalPreview = JournalAccess & { count: number };
export type JournalList = {
  journals: JournalPreview[];
  lastInventoriedAt: string | null;
  unresolvedCount: number;
};
export type WorkflowSummary = {
  content: string;
  url?: string;
  summary: { title: string; summary: string; keyPoints: string[] };
};
export type WorkflowSummaryEvent =
  | { type: "progress"; progress: CollectionProgress }
  | { type: "result"; result: WorkflowSummary }
  | { type: "error"; message: string; code: string };
