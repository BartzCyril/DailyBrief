import { useCallback, useEffect, useRef, useState } from "react";
import type { JournalList } from "@dailybrief/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Feedback } from "@/components/Feedback";
import { Modal } from "@/components/Modal";
import { JournalTable } from "@/sources/JournalTable";
import { sourcesApi } from "@/sources/api";
import { errorMessage } from "@/lib/api";

export function JournalManager({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<JournalList | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [addError, setAddError] = useState("");
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const journals = await sourcesApi.journals();
      if (requestId.current === id) setData(journals);
    } catch (error) {
      if (requestId.current === id) setError(errorMessage(error));
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh, refreshKey]);
  async function add() {
    setSaving(true);
    setAddError("");
    try {
      await sourcesApi.addJournal(domain);
      setDomain("");
      setAdding(false);
      await refresh();
    } catch (error) {
      setAddError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  const actions = (
    <div className="flex flex-wrap gap-3">
      <Modal
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          setAddError("");
          setDomain("");
        }}
        busy={saving}
        title="Ajouter un journal"
        description="Les hôtes avec et sans www ont des réglages distincts."
        trigger={
          <Button disabled={saving}>
            <Plus />
            Ajouter un journal
          </Button>
        }
      >
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="flex flex-col gap-2 text-sm">
            Domaine du nouveau journal
            <Input
              disabled={saving}
              required
              placeholder="www.lemonde.fr"
              value={domain}
              maxLength={2048}
              autoComplete="off"
              onChange={(event) => setDomain(event.target.value)}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            Le nouveau journal sera désactivé. Vous pourrez ensuite l'activer et configurer son
            accès.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Ajout en cours…" : "Enregistrer le journal"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setAdding(false);
                setDomain("");
                setAddError("");
              }}
            >
              Annuler
            </Button>
          </div>
          <Feedback message={addError} error />
        </form>
      </Modal>
    </div>
  );
  return (
    <div className="space-y-5">
      <JournalTable
        management
        loading={loading}
        journals={data?.journals ?? []}
        headerActions={actions}
        onStructureChange={refresh}
        onChange={(journal) => {
          requestId.current++;
          setLoading(false);
          setData((previous) =>
            previous
              ? {
                  ...previous,
                  journals: previous.journals.map((item) =>
                    item.domain === journal.domain ? journal : item,
                  ),
                }
              : previous,
          );
        }}
      />
      {loading && (
        <p role="status" className="text-sm">
          Chargement des journaux…
        </p>
      )}
      <Feedback message={error} error />
      {error && (
        <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
          Réessayer
        </Button>
      )}
      {data && !data.lastInventoriedAt && (
        <p className="text-sm text-muted-foreground">
          Aucun recensement disponible. Récupérez les articles dans le workflow d'un flux RSS avec
          sélecteur pour afficher ses comptes ici.
        </p>
      )}
      {Boolean(data?.unresolvedCount) && (
        <p className="text-sm" role="status">
          {data!.unresolvedCount}{" "}
          {data!.unresolvedCount === 1 ? "notice non résolue" : "notices non résolues"} dans ces
          recensements.
        </p>
      )}
    </div>
  );
}
