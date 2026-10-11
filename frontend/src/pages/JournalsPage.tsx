import { JournalManager } from "@/dashboard/JournalManager";

export function JournalsPage() {
  return (
    <main id="app-content" tabIndex={-1} className="app-page">
      <JournalManager showHeading />
    </main>
  );
}
