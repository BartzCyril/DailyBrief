import type { ScrapingConfig } from "./index";

export type SelectorAnalysisKind = "SCRAPING" | "RSS_LINK" | "JOURNAL_LOGIN";
export type SelectorAnalysisInput = { kind: SelectorAnalysisKind; url: string };
type AnalysisDetails = {
  analyzedUrl: string;
  message: string;
  complete: boolean;
  missingFields: string[];
};
export type SelectorAnalysisResult = AnalysisDetails &
  (
    | { kind: "SCRAPING"; scrapingConfig: ScrapingConfig }
    | { kind: "RSS_LINK"; articleLinkSelector: string }
    | {
        kind: "JOURNAL_LOGIN";
        loginConfig: {
          loginUrl: string;
          emailSelector: string;
          passwordSelector: string;
          submitSelector: string;
          successSelector?: string;
          articleContentSelector?: string | null;
        };
      }
  );
export type SelectorAnalysisResponse = SelectorAnalysisResult & { helpRequestId?: string };
