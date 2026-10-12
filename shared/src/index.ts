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
  newestFirst?: boolean;
};
export type SourceListQuery = {
  type?: Source["type"];
  status?: "all" | "active" | "inactive";
  query?: string;
  page?: number;
};
export type SourcePage = {
  sources: Source[];
  total: number;
  page: number;
  pageSize: number;
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
    interestPrompt?: string;
  };
  latestBrief?: DailyBriefSnapshot | null;
};
export type SettingsInput = {
  collectionEnabled: boolean;
  collectionTime: string;
  timezone: string;
  interestPrompt?: string;
};
export type BriefStory = { title: string; text: string; articleIds: string[] };
export type DailyBriefContent = {
  headline: string;
  lead: string;
  stories: BriefStory[];
  otherNews: BriefStory[];
  trends: string;
};
export type DailyBriefSnapshot = {
  id: string;
  runId: string;
  date: string;
  timezone: string;
  status: "READY" | "EMPTY" | "FAILED";
  content: DailyBriefContent | null;
  articleCount: number;
  error: string | null;
  createdAt: string;
};
export type DailyBriefArticle = {
  id: string;
  title: string;
  url: string | null;
  summary: string;
  keyPoints: string[];
  publishedAt: string | null;
};
export type DailyBriefArticlesPage = {
  articles: DailyBriefArticle[];
  total: number;
  page: number;
  pageSize: number;
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
  briefId?: string;
  briefStatus?: DailyBriefSnapshot["status"];
  failure?: CollectionFailure;
};
export type CollectionStage =
  "collection" | "source" | "storage" | "content" | "ai" | "brief" | "newsletter" | "email";
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
export type QueueState = "waiting" | "active" | "delayed" | "completed" | "failed";
export const articleJobStatuses = [
  "all",
  "waiting",
  "active",
  "completed",
  "failed",
  "skipped",
] as const;
export type ArticleJobStatus = (typeof articleJobStatuses)[number];
export type ArticleJobResult = {
  articleId: string;
  status: "completed" | "skipped" | "failed";
  newSummary: boolean;
  skipReason?: string;
  failure?: CollectionFailure;
};
export type CollectionRunSnapshot = {
  id: string;
  trigger: "manual" | "scheduled";
  state: QueueState;
  active: boolean;
  startedAt: string;
  finishedAt: string | null;
  total: number | null;
  completed: number;
  failed: number;
  skipped: number;
  events: CollectionProgress[];
  result: RunResult | null;
  error: string | null;
};
export type ArticleJobSnapshot = {
  id: string;
  articleId: string;
  title: string;
  sourceUrl: string;
  articleUrl: string | null;
  state: QueueState;
  attempts: number;
  skipped: boolean;
  progress: CollectionProgress | null;
  error: string | null;
  summary: { title: string; summary: string; keyPoints: string[] } | null;
  relevanceReason?: string | null;
  skipReason?: string | null;
};
export type ArticleJobsPage = {
  jobs: ArticleJobSnapshot[];
  total: number;
  page: number;
  pageSize: number;
};
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
  successSelector?: string | null;
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
  summary: { title: string; summary: string; keyPoints: string[] } | null;
  relevant?: boolean;
  reason?: string;
};
export type WorkflowSummaryEvent =
  | { type: "progress"; progress: CollectionProgress }
  | { type: "result"; result: WorkflowSummary }
  | { type: "error"; message: string; code: string };
