import { AppError, UpstreamHttpError } from "../src/errors";
import { fetchRemotePage, RemoteConnectionError, type FetchPage } from "../src/network";
import { renderPublicSelectorPage, type RenderSelectorPage } from "../src/selector-analysis";

export type PageDiagnosis = {
  label: string;
  success: boolean;
  httpStatus?: number;
  errorCode?: string;
  networkReason?: string;
  message?: string;
};

/** Only status and fixed error explanations are printed, never HTML, URLs or cookies. */
export async function diagnosePage(
  url: string,
  fetchPage: FetchPage = fetchRemotePage,
  renderPage: RenderSelectorPage = renderPublicSelectorPage,
): Promise<PageDiagnosis[]> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new AppError(400, "Une URL HTTP ou HTTPS sans identifiants est requise.", "UNSAFE_URL");
  const results: PageDiagnosis[] = [];
  for (const [label, load] of [
    ["Téléchargement sécurisé", () => fetchPage(url)],
    ["Chromium public", () => renderPage(url)],
  ] as const) {
    try {
      const page = await load();
      results.push({
        label,
        success: true,
        ...("status" in page ? { httpStatus: page.status } : {}),
      });
    } catch (error) {
      results.push({
        label,
        success: false,
        ...(error instanceof UpstreamHttpError
          ? {
              httpStatus: error.upstreamStatus,
              errorCode: "UPSTREAM_ERROR",
              message: `Refus HTTP ${error.upstreamStatus}.`,
            }
          : error instanceof RemoteConnectionError
            ? { errorCode: error.code, networkReason: error.reason, message: error.message }
            : error instanceof AppError
              ? { errorCode: error.code }
              : { errorCode: "PAGE_LOAD_FAILED" }),
      });
    }
  }
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length !== 1) {
    console.error("Utilisation : bun run diagnose:page https://exemple.fr/page");
    process.exitCode = 1;
  } else {
    try {
      console.log("Diagnostic du chargement public : aucun appel IA, connexion ou email.");
      const results = await diagnosePage(args[0]!);
      for (const result of results) {
        console.log(
          `${result.label} : ${result.success ? "OK" : "ÉCHEC"}${result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""}${result.errorCode ? ` · ${result.errorCode}` : ""}${result.networkReason ? ` · ${result.networkReason}` : ""}${result.message ? ` · ${result.message}` : ""}`,
        );
      }
      process.exitCode = results.every((result) => result.success) ? 0 : 1;
    } catch {
      console.error("Adresse invalide. Utilisez une URL publique HTTP ou HTTPS sans identifiants.");
      process.exitCode = 1;
    }
  }
}
