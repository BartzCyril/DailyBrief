import { useState, type ReactNode } from "react";
import type { JournalPreview, JournalLoginConfig } from "@dailybrief/shared";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/IconButton";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { Field } from "@/components/Field";
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
  [
    "loginUrl",
    "URL du formulaire de connexion",
    "https://journal.fr/connexion",
    "Adresse HTTPS de la page de connexion du journal, où se trouvent les champs email et mot de passe.",
  ],
  [
    "emailSelector",
    "Sélecteur du champ email",
    "input[type='email']",
    "Sélecteur CSS d'un unique champ input qui reçoit votre identifiant dans le formulaire de connexion.",
  ],
  [
    "passwordSelector",
    "Sélecteur du champ mot de passe",
    "input[type='password']",
    "Sélecteur CSS d'un unique input de type password dans le même formulaire.",
  ],
  [
    "submitSelector",
    "Sélecteur du bouton de connexion",
    "button[type='submit']",
    "Bouton qui envoie le formulaire de connexion, par exemple button[type='submit'].",
  ],
  [
    "successSelector",
    "Sélecteur visible après connexion",
    ".mon-compte",
    "Élément absent avant connexion et visible après, par exemple le menu de votre compte. À vérifier une fois connecté au journal.",
  ],
  [
    "articleContentSelector",
    "Sélecteur du contenu intégral (facultatif)",
    ".article-body",
    "Zone du texte complet sur la page d'un article, sans menus ni extrait d'abonnement. Laissez vide pour l'extraction automatique.",
  ],
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
  const accessConfigured = journal.hasCredentials && journal.authenticationSupported;
  const accessLabel = journal.hasCredentials
    ? journal.authenticationSupported
      ? "Formulaire configuré · connexion à vérifier"
      : "Identifiants enregistrés · formulaire à configurer"
    : "Non configuré";
  const accessActions = (
    <>
      {journal.loginConfig && (
        <>
          <Button
            variant="outline"
            disabled={pending || !journal.enabled || !journal.hasCredentials}
            onClick={() => void testConnection()}
          >
            {busy ? "Connexion en cours…" : "Tester la connexion"}
          </Button>
          <ConfirmDelete
            itemType="ce formulaire de connexion"
            description={`${journal.domain} — Les identifiants enregistrés seront conservés.`}
            onConfirm={() => saveAccess({ loginConfig: null })}
            trigger={
              <Button variant="outline" disabled={pending}>
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
            <Button variant="outline" disabled={pending}>
              Supprimer les identifiants
            </Button>
          }
        />
      )}
    </>
  );
  const accessModal = (
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
        management ? (
          <IconButton
            tooltip="Configurer l'accès"
            aria-label="Configurer l'accès"
            disabled={!journal.enabled || pending}
          >
            <KeyRound aria-hidden="true" />
          </IconButton>
        ) : (
          <Button variant="outline" disabled={!journal.enabled || pending}>
            Configurer l'accès
          </Button>
        )
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
          <Field
            label={`Email pour ${journal.domain}`}
            hint="Identifiant email de votre abonnement à ce journal. Il n'est pas envoyé à l'IA."
            type="email"
            required
            value={email}
            autoComplete="off"
            onChange={(event) => setEmail(event.target.value)}
          />
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
              successSelector: previous.successSelector || result.loginConfig.successSelector || "",
              articleContentSelector:
                previous.articleContentSelector || result.loginConfig.articleContentSelector || "",
            }));
          }}
        />
        <fieldset disabled={pending} className="min-w-0 space-y-5">
          <fieldset className="min-w-0 space-y-4 rounded-lg border p-4">
            <legend className="px-1 font-medium">Connexion automatique</legend>
            <p className="text-sm text-muted-foreground">
              Renseignez une URL HTTPS et des sélecteurs CSS. Les identifiants seront envoyés au
              site indiqué par cette URL. L'élément de réussite doit être absent avant connexion et
              visible après, par exemple le menu du compte. CAPTCHA et double authentification ne
              sont pas automatisés.
            </p>
            {formFields.map(([key, label, placeholder, hint]) => (
              <Field
                key={key}
                label={label}
                hint={hint}
                type={key === "loginUrl" ? "url" : "text"}
                placeholder={placeholder}
                value={form[key] ?? ""}
                required={
                  key !== "articleContentSelector" && Boolean(form.loginUrl || journal.loginConfig)
                }
                autoComplete="off"
                onChange={(event) => {
                  const value = event.target.value;
                  setForm((previous) => ({ ...previous, [key]: value }));
                  if (key === "loginUrl") setAssistanceUrl(value || `https://${journal.domain}`);
                }}
              />
            ))}
            <p className="text-sm text-muted-foreground">
              Pour un article réservé aux abonnés, indiquez la zone du contenu intégral afin
              d'éviter de résumer un extrait public. Enregistrez avant de tester la connexion.
            </p>
          </fieldset>
          <Field
            label={
              journal.hasCredentials ? "Nouveau mot de passe (vide : conserver)" : "Mot de passe"
            }
            hint="Mot de passe de votre abonnement, chiffré lors de l'enregistrement. Un champ vide conserve le mot de passe déjà enregistré."
            type="password"
            required={!journal.hasCredentials}
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
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
      {management && (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-3">{accessActions}</div>
          <Feedback message={connectionResult} />
        </div>
      )}
    </Modal>
  );
  return (
    <tr className={management ? "border-t align-middle" : "border-t align-top"}>
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
      <td className={management ? "p-3 text-center" : "p-3"}>{journal.count}</td>
      <td className={management ? "p-3 text-center" : "p-3"}>
        <Button
          variant={management ? "ghost" : "outline"}
          size={management ? "icon-sm" : "default"}
          className="cursor-pointer"
          title={
            management
              ? journal.enabled
                ? "Désactiver le journal"
                : "Activer le journal"
              : undefined
          }
          disabled={pending}
          aria-label={`${journal.enabled ? "Désactiver" : "Activer"} ${journal.domain}`}
          aria-pressed={journal.enabled}
          onClick={() => void update({ enabled: !journal.enabled })}
        >
          {management ? (
            <span
              aria-hidden="true"
              className={
                "size-2.5 rounded-full " + (journal.enabled ? "bg-green-600" : "bg-red-600")
              }
            />
          ) : journal.enabled ? (
            "Activé"
          ) : (
            "Désactivé"
          )}
        </Button>
      </td>
      {management ? (
        <td className="p-3 text-center">
          <span
            role="img"
            aria-label={accessLabel}
            title={accessLabel}
            className={
              "inline-block size-2.5 rounded-full " +
              (accessConfigured ? "bg-green-600" : "bg-red-600")
            }
          />
          <Feedback message={editing || renaming ? "" : error} error />
        </td>
      ) : (
        <>
          <td className="p-3 break-all">{journal.email ?? "—"}</td>
          <td className="min-w-64 p-3 space-y-3">
            <p>{accessLabel}</p>
            <div className="flex flex-col items-start gap-3">
              {accessModal}
              {accessActions}
            </div>
            <Feedback message={editing || renaming ? "" : error} error />
            <Feedback message={connectionResult} />
          </td>
        </>
      )}
      {management && (
        <td className="p-3">
          <div className="flex items-center justify-end gap-3">
            {accessModal}
            <Modal
              open={renaming}
              onOpenChange={(open) => {
                setRenaming(open);
                setDomain(journal.domain);
                setError("");
              }}
              busy={busy}
              title="Modifier le domaine du journal"
              trigger={
                <IconButton
                  tooltip="Modifier le domaine"
                  disabled={pending}
                  aria-label={`Modifier le domaine ${journal.domain}`}
                >
                  <Pencil aria-hidden="true" />
                </IconButton>
              }
            >
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void changeDomain();
                }}
              >
                <Field
                  label={`Nouveau domaine pour ${journal.domain}`}
                  hint="Nom d'hôte du journal, sans chemin, par exemple www.lemonde.fr."
                  required
                  disabled={busy}
                  value={domain}
                  maxLength={2048}
                  autoComplete="off"
                  onChange={(event) => setDomain(event.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  Changer de domaine désactive le journal et efface ses identifiants et son
                  formulaire de connexion.
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
              itemType={`le journal ${journal.domain}`}
              onConfirm={async () => {
                await sourcesApi.removeJournal(journal.domain);
                await onStructureChange?.();
              }}
              trigger={
                <IconButton
                  tooltip="Supprimer le journal"
                  className="text-destructive hover:text-destructive"
                  disabled={pending}
                  aria-label={`Supprimer le journal ${journal.domain}`}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
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
  const title = management ? "Journaux" : "Journaux de cet aperçu";
  return (
    <section aria-label={title} className="space-y-5">
      {(!management || headerActions) && (
        <div
          className={`flex flex-wrap items-center gap-3 ${management ? "justify-end" : "justify-between"}`}
        >
          {!management && <h2 className="text-xl font-semibold">{title}</h2>}
          {headerActions}
        </div>
      )}
      {!management && (
        <p className="text-sm">
          Les nouveaux journaux sont désactivés. Leur activation autorise l'extraction et l'IA. Les
          hôtes avec et sans www ont des réglages distincts. Les identifiants enregistrés ne
          garantissent pas une connexion.
        </p>
      )}
      <div
        className={management ? "overflow-x-auto rounded-lg border" : "overflow-x-auto"}
        tabIndex={0}
        role="region"
        aria-label="Tableau des journaux, défilement horizontal"
      >
        <table
          className={management ? "w-full min-w-[32rem] table-fixed text-sm" : "w-full text-sm"}
          aria-busy={loading}
        >
          <caption className="sr-only">
            Nombre d'articles par journal, par ordre décroissant
          </caption>
          <thead className={management ? "bg-muted/50" : undefined}>
            <tr>
              {[
                "Domaine du journal",
                "Nombre d'articles",
                "Statut",
                ...(!management ? ["Email"] : []),
                "Accès",
                ...(management ? ["Actions"] : []),
              ].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className={
                    management
                      ? `p-3 font-medium ${label === "Domaine du journal" ? "text-left" : label === "Actions" ? "w-36 text-right" : label === "Nombre d'articles" ? "w-24 text-center" : "w-16 text-center"}`
                      : "p-3 text-left"
                  }
                >
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
                <td colSpan={5} className="p-3 text-muted-foreground">
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
