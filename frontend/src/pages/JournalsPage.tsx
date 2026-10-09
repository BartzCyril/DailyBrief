import { JournalManager } from "@/dashboard/JournalManager";

export function JournalsPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-7 px-5 py-9">
      <div className="space-y-2">
        <h1 tabIndex={-1} className="text-3xl font-semibold">
          Journaux
        </h1>
        <p className="text-muted-foreground">
          Gérez les domaines, leur activation et leur accès pour toutes vos sources.
        </p>
      </div>
      <JournalManager />
    </main>
  );
}
