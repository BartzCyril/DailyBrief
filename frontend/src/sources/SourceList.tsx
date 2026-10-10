import type { Source, ScrapingConfig, SourcePage, SourceListQuery } from "@dailybrief/shared";
import { useId, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Feedback } from "@/components/Feedback";
import { sourcesApi } from "./api";
import { errorMessage } from "@/lib/api";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Pencil, Trash2, Play, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import { EditSourceForm } from "./EditSourceForm";
import { Modal } from "@/components/Modal";
import { ConfirmDelete } from "@/components/ConfirmDelete";
export function SourceList({
  sources,
  onChanged,
  pagination,
  controls,
  loading = false,
}: {
  sources: Source[];
  onChanged?: () => Promise<void>;
  pagination?: Omit<SourcePage, "sources">;
  controls?: {
    query: string;
    status: NonNullable<SourceListQuery["status"]>;
    onQueryChange: (query: string) => void;
    onStatusChange: (status: NonNullable<SourceListQuery["status"]>) => void;
    onPageChange: (page: number) => void;
  };
  loading?: boolean;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState("");
  const [helpBusyId, setHelpBusyId] = useState("");
  const [message, setMessage] = useState("");
  const statusId = useId();
  const {
    total,
    page: currentPage,
    pageSize,
  } = pagination ?? { total: sources.length, page: 1, pageSize: 5 };
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = (currentPage - 1) * pageSize;
  const pending = !!busy || loading;
  async function remove(source: Source) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.remove(source.id);
      await onChanged?.();
      setEditingId((previous) => (previous === source.id ? "" : previous));
      setMessage("Source supprimée.");
    } finally {
      setBusy("");
    }
  }
  async function updateSource(
    source: Source,
    url: string,
    config?: ScrapingConfig,
    articleLinkSelector?: string | null,
  ) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.update(source.id, url, config, articleLinkSelector);
      await onChanged?.();
      setEditingId("");
      setMessage("Source modifiée.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  async function toggle(source: Source, enabled: boolean) {
    if (busy) return;
    setBusy(source.id);
    setError("");
    setMessage("");
    try {
      await sourcesApi.setEnabled(source.id, enabled);
      await onChanged?.();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="space-y-5">
      <Feedback message={editingId ? "" : error} error />
      <Feedback message={message} />
      {controls && (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
          <Field
            label="Rechercher une URL"
            hint="Recherchez une partie de l'adresse parmi les sources de cet onglet."
            type="search"
            placeholder="https://…"
            maxLength={2000}
            value={controls.query}
            disabled={!!busy}
            onChange={(event) => {
              controls.onQueryChange(event.target.value);
            }}
          />
          <div className="grid gap-2">
            <Label htmlFor={statusId}>Statut des sources</Label>
            <select
              id={statusId}
              value={controls.status}
              disabled={!!busy}
              onChange={(event) => {
                controls.onStatusChange(
                  event.target.value as NonNullable<SourceListQuery["status"]>,
                );
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              <option value="all">Toutes les sources</option>
              <option value="active">Actives</option>
              <option value="inactive">Inactives</option>
            </select>
          </div>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border" aria-busy={loading}>
        <table className="w-full min-w-[32rem] table-fixed text-sm">
          <caption className="sr-only">Sources configurées</caption>
          <thead className="border-b bg-muted/50">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                URL
              </th>
              <th scope="col" className="w-20 px-3 py-3 text-center font-medium">
                Statut
              </th>
              <th scope="col" className="w-48 px-3 py-3 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {sources.map((source) => (
              <tr key={source.id}>
                <td className="px-4 py-4 align-middle">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-primary underline underline-offset-4"
                  >
                    {source.url}
                    <ExternalLink className="ml-2 inline size-3.5" aria-hidden="true" />
                  </a>
                </td>
                <td className="px-3 py-4 text-center align-middle">
                  <span
                    role="img"
                    aria-label={source.enabled ? "Active" : "Inactive"}
                    title={source.enabled ? "Active" : "Inactive"}
                    className={`inline-block size-2.5 rounded-full ${source.enabled ? "bg-green-600" : "bg-red-600"}`}
                  />
                </td>
                <td className="px-3 py-4 align-middle">
                  <div className="flex items-center justify-end gap-3">
                    <IconButton
                      tooltip="Tester le workflow de A à Z"
                      aria-label="Tester le workflow de A à Z"
                      asChild
                    >
                      <Link to={`/sources/${source.id}/workflow`}>
                        <Play aria-hidden="true" />
                      </Link>
                    </IconButton>
                    {onChanged && (
                      <>
                        <Modal
                          open={editingId === source.id}
                          onOpenChange={(open) => {
                            setEditingId(open ? source.id : "");
                            setError("");
                            setMessage("");
                          }}
                          busy={!!busy || helpBusyId === source.id}
                          title={
                            source.type === "RSS"
                              ? "Modifier le flux RSS"
                              : "Modifier la source de scraping"
                          }
                          description={source.url}
                          trigger={
                            <IconButton
                              tooltip="Modifier la source"
                              disabled={pending}
                              aria-label={`Modifier ${source.url}`}
                            >
                              <Pencil aria-hidden="true" />
                            </IconButton>
                          }
                        >
                          <EditSourceForm
                            key={source.id}
                            source={source}
                            busy={!!busy}
                            onBlockingChange={(blocked) =>
                              setHelpBusyId((current) =>
                                blocked ? source.id : current === source.id ? "" : current,
                              )
                            }
                            onSave={(url, config, articleLinkSelector) =>
                              updateSource(source, url, config, articleLinkSelector)
                            }
                            onCancel={() => {
                              setEditingId("");
                              setError("");
                            }}
                          />
                          <div className="mt-4">
                            <Feedback message={error} error />
                          </div>
                        </Modal>
                        <ConfirmDelete
                          itemType={
                            source.type === "RSS" ? "ce flux RSS" : "cette source de scraping"
                          }
                          description={`${source.url} — Les articles et résumés associés seront également supprimés.`}
                          onConfirm={() => remove(source)}
                          trigger={
                            <IconButton
                              tooltip="Supprimer la source"
                              className="text-destructive hover:text-destructive"
                              disabled={pending}
                              aria-label={`Supprimer ${source.url}`}
                            >
                              <Trash2 aria-hidden="true" />
                            </IconButton>
                          }
                        />
                        <Switch
                          title={source.enabled ? "Désactiver la source" : "Activer la source"}
                          aria-label={`Activer ${source.url}`}
                          checked={source.enabled}
                          disabled={pending}
                          onCheckedChange={(enabled) => void toggle(source, enabled)}
                        />
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!sources.length && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                  {loading
                    ? "Chargement des sources…"
                    : controls && (controls.query.trim() || controls.status !== "all")
                      ? "Aucune source ne correspond à votre recherche ou à ce filtre."
                      : "Aucune source configurée dans cet onglet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {controls && (
        <nav
          aria-label="Pagination des sources"
          className="flex flex-wrap items-center justify-between gap-4"
        >
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {total ? `${start + 1}–${Math.min(start + pageSize, total)} sur ${total}` : "0"} source
            {total === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Page précédente"
              disabled={pending || currentPage === 1}
              onClick={() => controls.onPageChange(currentPage - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span className="text-sm">
              Page {currentPage} sur {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Page suivante"
              disabled={pending || currentPage === pageCount}
              onClick={() => controls.onPageChange(currentPage + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
