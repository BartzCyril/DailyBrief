import type { CollectionEvent, CollectionProgress, RunResult } from "@dailybrief/shared";
import { apiResponse, ApiError } from "@/lib/api";
import { readEventStream } from "@/lib/event-stream";

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
  let result: RunResult | undefined;
  try {
    await readEventStream<CollectionEvent>(response, (event) => {
      if (event.type === "progress") onProgress(event.progress);
      else if (event.type === "result") result = event.result;
      else if (event.type === "error") throw new ApiError(0, event.message, event.code);
    });
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted) throw error;
    throw interrupted();
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
