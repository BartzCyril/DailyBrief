import type { CollectionProgress } from "@dailybrief/shared";

export type ProgressObserver = (progress: CollectionProgress) => void;
export function reportProgress(
  observer: ProgressObserver | undefined,
  progress: Omit<CollectionProgress, "at">,
) {
  // A disconnected viewer must never interrupt collection or delivery.
  try {
    observer?.({ ...progress, at: new Date().toISOString() });
  } catch {
    // The pipeline continues independently of its progress subscriber.
  }
}
