import { useState, type ReactNode } from "react";
import type { JournalPreview, JournalLoginConfig } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Feedback } from "@/components/Feedback";
import { sourcesApi } from "./api";
import { errorMessage } from "@/lib/api";

function formDefaults(journal: JournalPreview): JournalLoginConfig {
  return (
    journal.loginConfig ?? {
      loginUrl: "",
      emailSelector: "input[type='email']",
      passwordSelector: "input[type='password']",
      submitSelector: "button[type='submit']",
      successSelector: "",
      articleContentSelector: "",
    }
  );
}
const formFields = [
  ["loginUrl", "URL du formulaire de connexion", "https://journal.fr/connexion"],
  ["emailSelector", "Sélecteur du champ email", "input[type='email']"],
  ["passwordSelector", "Sélecteur du champ mot de passe", "input[type='password']"],
  ["submitSelector", "Sélecteur du bouton de connexion", "button[type='submit']"],
  ["successSelector", "Sélecteur visible après connexion", ".mon-compte"],
  ["articleContentSelector", "Sélecteur du contenu intégral (facultatif)", ".article-body"],
] as const;

function JournalRow({
  journal,
  onChange,
  management = false,
  onStructureChange,
}: {
  journal: JournalPreview;
  onChange: (journal: JournalPreview) => void;
  management?: boolean;
  onStructureChange?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(journal.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<JournalLoginConfig>(() => formDefaults(journal));
  const [connectionResult, setConnectionResult] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [domain, setDomain] = useState(journal.domain);
  async function changeStructure(remove = false) {
    if (
      remove &&
      !window.confirm(
        `Supprimer ${journal.domain} et ses réglages d'accès ? Les articles existants sont conservés. Si ce domaine réapparaît dans un flux RSS, il sera recréé désactivé.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setConnectionResult("");
    setPassword("");
    try {
      if (remove) await sourcesApi.removeJournal(journal.domain);
      else await sourcesApi.updateJournal(journal.domain, { domain });
      setRenaming(false);
      await onStructureChange?.();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function update(body: Parameters<typeof sourcesApi.updateJournal>[1]) {
    setBusy(true);
    setError("");
    setConnectionResult("");
    try {
      const saved = await sourcesApi.updateJournal(journal.domain, body);
      onChange({ ...saved, count: journal.count });
      setEmail(saved.email ?? "");
      setPassword("");
      setEditing(false);
      setForm(formDefaults({ ...saved, count: journal.count }));
    } catch (error) {
      setError(errorMessage(error));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }
  async function testConnection() {
    setBusy(true);
    setError("");
    setConnectionResult("");
    try {
      const result = await sourcesApi.testJournalConnection(journal.domain);
      if (result.authenticated) setConnectionResult(result.message);
    } catch (error) {
      setError(errorMessage(error));
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
              ? "Formulaire configuré · connexion à vérifier"
              : "Identifiants enregistrés · formulaire à configurer"
            : "Non configuré"}
        </p>
        <Button
          variant="outline"
          disabled={!journal.enabled || busy}
          onClick={() => {
            setRenaming(false);
            setPassword("");
            setEmail(journal.email ?? "");
            setForm(formDefaults(journal));
            setEditing(!editing);
          }}
        >
          Configurer l'accès
        </Button>
        {journal.loginConfig && (
          <>
            <Button
              variant="outline"
              disabled={busy || editing || !journal.enabled || !journal.hasCredentials}
              onClick={() => void testConnection()}
            >
              {busy ? "Connexion en cours…" : "Tester la connexion"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void update({ loginConfig: null })}
            >
              Supprimer le formulaire
            </Button>
          </>
        )}
        {journal.hasCredentials && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void update({ clearCredentials: true })}
          >
            Supprimer les identifiants
          </Button>
        )}
        {renaming && (
          <form
            className="space-y-2 rounded-md border p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void changeStructure();
            }}
          >
            <label className="block">
              Nouveau domaine pour {journal.domain}
              <Input
                required
                value={domain}
                maxLength={2048}
                autoComplete="off"
                onChange={(event) => setDomain(event.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Changer de domaine désactive le journal et efface ses identifiants et son formulaire
              de connexion. Les hôtes avec et sans www sont distincts.
            </p>
            <Button type="submit" disabled={busy}>
              Enregistrer le domaine
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setRenaming(false)}
            >
              Annuler
            </Button>
          </form>
        )}
        {editing && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void update({
                email,
                password,
                ...(form.loginUrl.trim()
                  ? {
                      loginConfig: {
                        ...form,
                        articleContentSelector: form.articleContentSelector?.trim() || null,
                      },
                    }
                  : {}),
              });
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
            <fieldset className="space-y-2 rounded-md border p-2">
              <legend className="px-1 font-medium">Connexion automatique</legend>
              <p className="text-sm text-muted-foreground">
                Renseignez une URL HTTPS et des sélecteurs CSS. Les identifiants seront envoyés au
                site indiqué par cette URL. L'élément de réussite doit être absent avant connexion
                et visible après, par exemple le menu du compte. CAPTCHA et double authentification
                ne sont pas automatisés.
              </p>
              {formFields.map(([key, label, placeholder]) => (
                <label key={key} className="block">
                  {label}
                  <Input
                    type={key === "loginUrl" ? "url" : "text"}
                    placeholder={placeholder}
                    value={form[key] ?? ""}
                    required={
                      key !== "articleContentSelector" &&
                      Boolean(form.loginUrl || journal.loginConfig)
                    }
                    autoComplete="off"
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, [key]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <p className="text-sm text-muted-foreground">
                Pour un article réservé aux abonnés, indiquez la zone du contenu intégral afin
                d'éviter de résumer un extrait public. Enregistrez avant de tester la connexion.
              </p>
            </fieldset>
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
        <Feedback message={connectionResult} />
      </td>
      {management && (
        <td className="p-3 space-y-2">
          <Button
            variant="outline"
            disabled={busy}
            aria-label={`Modifier le domaine ${journal.domain}`}
            onClick={() => {
              setEditing(false);
              setPassword("");
              setRenaming(!renaming);
              setDomain(journal.domain);
            }}
          >
            Modifier le domaine
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            aria-label={`Supprimer le journal ${journal.domain}`}
            onClick={() => void changeStructure(true)}
          >
            Supprimer
          </Button>
        </td>
      )}
    </tr>
  );
}

export function JournalTable({
  journals,
  onChange,
  management = false,
  onStructureChange,
  headerActions,
  loading = false,
}: {
  journals: JournalPreview[];
  onChange: (journal: JournalPreview) => void;
  management?: boolean;
  onStructureChange?: () => Promise<void>;
  headerActions?: ReactNode;
  loading?: boolean;
}) {
  const title = management ? "Vos journaux" : "Journaux de cet aperçu";
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        {headerActions}
      </div>
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
        <table className="w-full text-sm" aria-busy={loading}>
          <caption className="sr-only">
            Nombre d'articles par journal, par ordre décroissant
          </caption>
          <thead>
            <tr>
              {[
                "Domaine du journal",
                "Nombre d'articles",
                "Statut",
                "Email",
                "Accès",
                ...(management ? ["Actions"] : []),
              ].map((label) => (
                <th key={label} scope="col" className="p-3 text-left">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {journals.map((journal) => (
              <JournalRow
                key={journal.domain}
                journal={journal}
                onChange={onChange}
                management={management}
                onStructureChange={onStructureChange}
              />
            ))}
            {!journals.length && !loading && (
              <tr>
                <td colSpan={management ? 6 : 5} className="p-3 text-muted-foreground">
                  {management
                    ? "Aucun journal enregistré. Ajoutez un domaine ou recensez les articles d'un flux RSS avec sélecteur."
                    : "Aucun journal recensé."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
