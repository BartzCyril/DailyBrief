import { useState } from "react";
import type { JournalPreview } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Feedback } from "@/components/Feedback";
import { sourcesApi } from "./api";
import { errorMessage } from "@/lib/api";

function JournalRow({
  journal,
  onChange,
}: {
  journal: JournalPreview;
  onChange: (journal: JournalPreview) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(journal.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(body: Parameters<typeof sourcesApi.updateJournal>[1]) {
    setBusy(true);
    setError("");
    try {
      const saved = await sourcesApi.updateJournal(journal.domain, body);
      onChange({ ...saved, count: journal.count });
      setEmail(saved.email ?? "");
      setPassword("");
      setEditing(false);
    } catch (error) {
      setError(errorMessage(error));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr className="border-t align-top">
      <th scope="row" className="p-3 text-left font-medium break-all">
        <a
          href={`https://${journal.domain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          {journal.domain}
        </a>
      </th>
      <td className="p-3">{journal.count}</td>
      <td className="p-3">
        <Button
          variant="outline"
          disabled={busy}
          aria-label={`${journal.enabled ? "Désactiver" : "Activer"} ${journal.domain}`}
          aria-pressed={journal.enabled}
          onClick={() => void update({ enabled: !journal.enabled })}
        >
          {journal.enabled ? "Activé" : "Désactivé"}
        </Button>
      </td>
      <td className="p-3 break-all">{journal.email ?? "—"}</td>
      <td className="min-w-64 p-3 space-y-2">
        <p>
          {journal.hasCredentials
            ? journal.authenticationSupported
              ? "Identifiants enregistrés"
              : "Identifiants enregistrés · connexion non prise en charge"
            : "Non configuré"}
        </p>
        <Button
          variant="outline"
          disabled={!journal.enabled || busy}
          onClick={() => {
            setPassword("");
            setEmail(journal.email ?? "");
            setEditing(!editing);
          }}
        >
          Configurer l'accès
        </Button>
        {journal.hasCredentials && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void update({ clearCredentials: true })}
          >
            Supprimer les identifiants
          </Button>
        )}
        {editing && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void update({ email, password });
            }}
          >
            <label className="block">
              Email pour {journal.domain}
              <Input
                type="email"
                required
                value={email}
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block">
              {journal.hasCredentials ? "Nouveau mot de passe (vide : conserver)" : "Mot de passe"}
              <Input
                type="password"
                required={!journal.hasCredentials}
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy}>
              Enregistrer les identifiants
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPassword("");
                setEditing(false);
              }}
            >
              Annuler
            </Button>
          </form>
        )}
        <Feedback message={error} error />
      </td>
    </tr>
  );
}

export function JournalTable({
  journals,
  onChange,
}: {
  journals: JournalPreview[];
  onChange: (journal: JournalPreview) => void;
}) {
  return (
    <section aria-label="Journaux de cet aperçu" className="space-y-3">
      <h2 className="text-xl font-semibold">Journaux de cet aperçu</h2>
      <p className="text-sm">
        Les nouveaux journaux sont désactivés. Leur activation autorise l'extraction et l'IA. Les
        hôtes avec et sans www ont des réglages distincts. Les identifiants enregistrés ne
        garantissent pas une connexion.
      </p>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Tableau des journaux, défilement horizontal"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">
            Nombre d'articles par journal, par ordre décroissant
          </caption>
          <thead>
            <tr>
              {["Domaine du journal", "Nombre d'articles", "Statut", "Email", "Accès"].map(
                (label) => (
                  <th key={label} scope="col" className="p-3 text-left">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {journals.map((journal) => (
              <JournalRow key={journal.domain} journal={journal} onChange={onChange} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
