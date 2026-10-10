import { useState, type ReactNode } from "react";
import type { JournalPreview, JournalLoginConfig } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Feedback } from "@/components/Feedback";
import { Modal } from "@/components/Modal";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { sourcesApi } from "./api";
import { errorMessage } from "@/lib/api";
import { SelectorAssistance, type SelectorAssistancePending } from "./SelectorAssistance";

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
  const [assistancePending, setAssistancePending] = useState<SelectorAssistancePending>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState<JournalLoginConfig>(() => formDefaults(journal));
  const [assistanceUrl, setAssistanceUrl] = useState(
    journal.loginConfig?.loginUrl || `https://${journal.domain}`,
  );
  const pending = busy || !!assistancePending;
  const modalBusy = busy || assistancePending === "help";
  const [connectionResult, setConnectionResult] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [domain, setDomain] = useState(journal.domain);
  async function changeDomain() {
    if (pending) return;
    setBusy(true);
    setError("");
    setConnectionResult("");
    setPassword("");
    try {
      await sourcesApi.updateJournal(journal.domain, { domain });
      await onStructureChange?.();
      setRenaming(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function saveAccess(body: Parameters<typeof sourcesApi.updateJournal>[1]) {
    setError("");
    setConnectionResult("");
    const saved = await sourcesApi.updateJournal(journal.domain, body);
    onChange({ ...saved, count: journal.count });
    setEmail(saved.email ?? "");
    setPassword("");
    setEditing(false);
    setForm(formDefaults({ ...saved, count: journal.count }));
  }
  async function update(body: Parameters<typeof sourcesApi.updateJournal>[1]) {
    if (pending) return;
    setBusy(true);
    setError("");
    setConnectionResult("");
    try {
      await saveAccess(body);
    } catch (error) {
      setError(errorMessage(error));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }
  async function testConnection() {
    if (pending) return;
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
          disabled={pending}
          aria-label={`${journal.enabled ? "Désactiver" : "Activer"} ${journal.domain}`}
          aria-pressed={journal.enabled}
          onClick={() => void update({ enabled: !journal.enabled })}
        >
          {journal.enabled ? "Activé" : "Désactivé"}
        </Button>
      </td>
      <td className="p-3 break-all">{journal.email ?? "—"}</td>
      <td className="min-w-64 p-3 space-y-3">
        <p>
          {journal.hasCredentials
            ? journal.authenticationSupported
              ? "Formulaire configuré · connexion à vérifier"
              : "Identifiants enregistrés · formulaire à configurer"
            : "Non configuré"}
        </p>
        <div className="flex flex-col items-start gap-3">
          <Modal
            open={editing}
            onOpenChange={(open) => {
              setEditing(open);
              setPassword("");
              setError("");
              if (open) {
                setEmail(journal.email ?? "");
                setForm(formDefaults(journal));
                setAssistanceUrl(journal.loginConfig?.loginUrl || `https://${journal.domain}`);
              }
            }}
            busy={modalBusy}
            title={`Configurer l'accès à ${journal.domain}`}
            description="Enregistrez les identifiants et, si nécessaire, les paramètres du formulaire de connexion."
            trigger={
              <Button variant="outline" disabled={!journal.enabled || pending}>
                Configurer l'accès
              </Button>
            }
          >
            <form
              className="space-y-5"
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
              <fieldset disabled={pending} className="min-w-0 space-y-5">
                <label className="flex flex-col gap-2 text-sm">
                  Email pour {journal.domain}
                  <Input
                    type="email"
                    required
                    value={email}
                    autoComplete="off"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              </fieldset>
              <SelectorAssistance
                kind="JOURNAL_LOGIN"
                url={assistanceUrl}
                disabled={busy}
                onPendingChange={setAssistancePending}
                onStart={() => {
                  setError("");
                  setConnectionResult("");
                }}
                onResult={(result) => {
                  if (result.kind !== "JOURNAL_LOGIN") return;
                  setForm((previous) => ({
                    ...previous,
                    ...result.loginConfig,
                    successSelector:
                      previous.successSelector || result.loginConfig.successSelector || "",
                    articleContentSelector:
                      previous.articleContentSelector ||
                      result.loginConfig.articleContentSelector ||
                      "",
                  }));
                }}
              />
              <fieldset disabled={pending} className="min-w-0 space-y-5">
                <fieldset className="min-w-0 space-y-4 rounded-lg border p-4">
                  <legend className="px-1 font-medium">Connexion automatique</legend>
                  <p className="text-sm text-muted-foreground">
                    Renseignez une URL HTTPS et des sélecteurs CSS. Les identifiants seront envoyés
                    au site indiqué par cette URL. L'élément de réussite doit être absent avant
                    connexion et visible après, par exemple le menu du compte. CAPTCHA et double
                    authentification ne sont pas automatisés.
                  </p>
                  {formFields.map(([key, label, placeholder]) => (
                    <label key={key} className="flex flex-col gap-2 text-sm">
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
                        onChange={(event) => {
                          const value = event.target.value;
                          setForm((previous) => ({ ...previous, [key]: value }));
                          if (key === "loginUrl")
                            setAssistanceUrl(value || `https://${journal.domain}`);
                        }}
                      />
                    </label>
                  ))}
                  <p className="text-sm text-muted-foreground">
                    Pour un article réservé aux abonnés, indiquez la zone du contenu intégral afin
                    d'éviter de résumer un extrait public. Enregistrez avant de tester la connexion.
                  </p>
                </fieldset>
                <label className="flex flex-col gap-2 text-sm">
                  {journal.hasCredentials
                    ? "Nouveau mot de passe (vide : conserver)"
                    : "Mot de passe"}
                  <Input
                    type="password"
                    required={!journal.hasCredentials}
                    value={password}
                    autoComplete="new-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </fieldset>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={pending}>
                  Enregistrer les identifiants
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={modalBusy}
                  onClick={() => {
                    setPassword("");
                    setEditing(false);
                  }}
                >
                  Annuler
                </Button>
              </div>
              <Feedback message={error} error />
            </form>
          </Modal>
          {journal.loginConfig && (
            <>
              <Button
                variant="outline"
                disabled={busy || !journal.enabled || !journal.hasCredentials}
                onClick={() => void testConnection()}
              >
                {busy ? "Connexion en cours…" : "Tester la connexion"}
              </Button>
              <ConfirmDelete
                itemType="ce formulaire de connexion"
                description={`${journal.domain} — Les identifiants enregistrés seront conservés.`}
                onConfirm={() => saveAccess({ loginConfig: null })}
                trigger={
                  <Button variant="outline" disabled={busy}>
                    Supprimer le formulaire
                  </Button>
                }
              />
            </>
          )}
          {journal.hasCredentials && (
            <ConfirmDelete
              itemType="ces identifiants de connexion"
              description={`${journal.domain} — L'email, le mot de passe et la session de connexion seront supprimés.`}
              onConfirm={() => saveAccess({ clearCredentials: true })}
              trigger={
                <Button variant="outline" disabled={busy}>
                  Supprimer les identifiants
                </Button>
              }
            />
          )}
        </div>
        <Feedback message={editing || renaming ? "" : error} error />
        <Feedback message={connectionResult} />
      </td>
      {management && (
        <td className="p-3">
          <div className="flex flex-col items-start gap-3">
            <Modal
              open={renaming}
              onOpenChange={(open) => {
                setRenaming(open);
                setDomain(journal.domain);
                setError("");
              }}
              busy={busy}
              title="Modifier le domaine du journal"
              description={journal.domain}
              trigger={
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-label={`Modifier le domaine ${journal.domain}`}
                >
                  Modifier le domaine
                </Button>
              }
            >
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void changeDomain();
                }}
              >
                <label className="flex flex-col gap-2 text-sm">
                  Nouveau domaine pour {journal.domain}
                  <Input
                    required
                    disabled={busy}
                    value={domain}
                    maxLength={2048}
                    autoComplete="off"
                    onChange={(event) => setDomain(event.target.value)}
                  />
                </label>
                <p className="text-sm text-muted-foreground">
                  Changer de domaine désactive le journal et efface ses identifiants et son
                  formulaire de connexion. Les hôtes avec et sans www sont distincts.
                </p>
                <div className="flex flex-wrap gap-3">
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
                </div>
                <Feedback message={error} error />
              </form>
            </Modal>
            <ConfirmDelete
              itemType="ce journal"
              description={`${journal.domain} — Les réglages d'accès seront supprimés et les articles existants conservés. Si ce domaine réapparaît dans un flux RSS, il sera recréé désactivé.`}
              onConfirm={async () => {
                await sourcesApi.removeJournal(journal.domain);
                await onStructureChange?.();
              }}
              trigger={
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-label={`Supprimer le journal ${journal.domain}`}
                >
                  Supprimer
                </Button>
              }
            />
          </div>
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
    <section aria-label={title} className="space-y-5">
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
