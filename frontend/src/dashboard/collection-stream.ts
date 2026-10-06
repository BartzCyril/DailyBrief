import type { CollectionEvent, CollectionProgress, RunResult } from "@dailybrief/shared";
import { apiResponse, ApiError } from "@/lib/api";

export async function streamCollection(
  onProgress: (progress: CollectionProgress) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  const response = await apiResponse("/collection/run", {
    method: "POST",
    body: {},
    accept: "application/x-ndjson",
    signal,
  });
  if (!response.headers.get("content-type")?.includes("application/x-ndjson"))
    return (await response.json()) as RunResult;
  if (!response.body) throw new ApiError(0, "Le suivi de la collecte est indisponible.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: RunResult | undefined;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line) as CollectionEvent;
    if (event.type === "progress") onProgress(event.progress);
    else if (event.type === "result") result = event.result;
    else if (event.type === "error") throw new ApiError(0, event.message, event.code);
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted) throw error;
    throw interrupted();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!result) throw interrupted();
  return result;
}
function interrupted() {
  return new ApiError(
    0,
    "Le suivi a été interrompu. La collecte peut continuer sur le serveur ; vérifiez son résultat avant de relancer.",
  );
}
