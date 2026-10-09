import type {
  Source,
  SourcePreview,
  ScrapingConfig,
  WorkflowPreview,
  WorkflowSummary,
  WorkflowSummaryEvent,
  CollectionProgress,
  JournalAccess,
  JournalLoginConfig,
  JournalList,
} from "@dailybrief/shared";
import { api, apiResponse, ApiError } from "@/lib/api";
import { readEventStream } from "@/lib/event-stream";
export const sourcesApi = {
  journals: () => api<JournalList>("/journals"),
  addJournal: (domain: string) =>
    api<JournalAccess>("/journals", { method: "POST", body: { domain } }),
  removeJournal: (domain: string) =>
    api<void>(`/journals/${encodeURIComponent(domain)}`, { method: "DELETE" }),
  updateJournal: (
    domain: string,
    body: {
      domain?: string;
      enabled?: boolean;
      email?: string;
      password?: string;
      clearCredentials?: boolean;
      loginConfig?: JournalLoginConfig | null;
    },
  ) => api<JournalAccess>(`/journals/${encodeURIComponent(domain)}`, { method: "PATCH", body }),
  testJournalConnection: (domain: string) =>
    api<{ authenticated: boolean; message: string }>(
      `/journals/${encodeURIComponent(domain)}/test`,
      { method: "POST", body: {} },
    ),
  list: () => api<Source[]>("/sources"),
  remove: (id: string) => api<void>(`/sources/${id}`, { method: "DELETE" }),
  testRss: (url: string, articleLinkSelector?: string | null) =>
    api<SourcePreview>("/sources/rss/test", {
      method: "POST",
      body: { url, ...(articleLinkSelector !== undefined ? { articleLinkSelector } : {}) },
    }),
  saveRss: (url: string, articleLinkSelector?: string | null) =>
    api<Source>("/sources", {
      method: "POST",
      body: {
        url,
        type: "RSS",
        ...(articleLinkSelector !== undefined ? { articleLinkSelector } : {}),
      },
    }),
  testScraping: (url: string, config: ScrapingConfig) =>
    api<SourcePreview>("/sources/scraping/test", { method: "POST", body: { url, config } }),
  saveScraping: (url: string, scrapingConfig: ScrapingConfig) =>
    api<Source>("/sources", { method: "POST", body: { url, type: "SCRAPING", scrapingConfig } }),
  setEnabled: (id: string, enabled: boolean) =>
    api<void>(`/sources/${id}`, { method: "PATCH", body: { enabled } }),
  update: (
    id: string,
    url: string,
    scrapingConfig?: ScrapingConfig,
    articleLinkSelector?: string | null,
  ) =>
    api<void>(`/sources/${id}`, {
      method: "PATCH",
      body: {
        url,
        ...(scrapingConfig !== undefined ? { scrapingConfig } : {}),
        ...(articleLinkSelector !== undefined ? { articleLinkSelector } : {}),
      },
    }),
  workflow: (sourceId: string, signal?: AbortSignal) =>
    api<WorkflowPreview>(`/sources/${sourceId}/workflow`, { method: "POST", body: {}, signal }),
};
export async function summarizeWorkflowArticle(
  sourceId: string,
  workflowId: string,
  index: number,
  onProgress: (event: CollectionProgress) => void,
  signal?: AbortSignal,
): Promise<WorkflowSummary> {
  const response = await apiResponse(
    `/sources/${sourceId}/workflow/${workflowId}/articles/${index}/summarize`,
    {
      method: "POST",
      body: {},
      accept: "application/x-ndjson",
      signal,
    },
  );
  let result: WorkflowSummary | undefined;
  try {
    await readEventStream<WorkflowSummaryEvent>(response, (event) => {
      if (event.type === "progress") onProgress(event.progress);
      else if (event.type === "result") result = event.result;
      else throw new ApiError(0, event.message, event.code);
    });
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted) throw error;
    throw new ApiError(0, "Le suivi du résumé a été interrompu. Vous pouvez relancer le test.");
  }
  if (!result) throw new ApiError(0, "Le test s'est terminé sans résumé. Vous pouvez le relancer.");
  return result;
}
export function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
