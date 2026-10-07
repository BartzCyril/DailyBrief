import { useState, type FormEvent } from "react";
import type { Source } from "@dailybrief/shared";
import { LoaderCircle } from "lucide-react";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { validHttpUrl } from "./api";

export function EditSourceForm({
  source,
  busy,
  onSave,
  onCancel,
}: {
  source: Source;
  busy: boolean;
  onSave: (url: string, urlTemplate?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const pagination =
    source.scrapingConfig?.mode === "PAGINATE" ? source.scrapingConfig.pagination : undefined;
  const hasTemplate = pagination?.strategy === "URL_TEMPLATE";
  const [url, setUrl] = useState(source.url);
  const [template, setTemplate] = useState(pagination?.urlTemplate ?? "");
  const [templateEdited, setTemplateEdited] = useState(false);
  const [error, setError] = useState("");
  const unchanged =
    url.trim() === source.url && (!hasTemplate || template.trim() === pagination?.urlTemplate);
  function changeUrl(value: string) {
    const originalTemplate = pagination?.urlTemplate ?? "";
    const suffix = originalTemplate.slice(source.url.length);
    if (
      hasTemplate &&
      !templateEdited &&
      originalTemplate.startsWith(source.url) &&
      (source.url.endsWith("/") || !suffix || "/?&#".includes(suffix[0]!))
    )
      setTemplate(value + suffix);
    setUrl(value);
    setError("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || unchanged) return;
    setError("");
    if (!validHttpUrl(url.trim())) {
      setError("Saisissez une URL HTTP ou HTTPS valide.");
      return;
    }
    if (
      hasTemplate &&
      (!template.includes("{page}") || !validHttpUrl(template.replaceAll("{page}", "0").trim()))
    ) {
      setError("Le modèle de pagination doit être une URL HTTP ou HTTPS contenant {page}.");
      return;
    }
    await onSave(url.trim(), hasTemplate ? template.trim() : undefined);
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="w-full space-y-4 border-t pt-4"
      aria-label={`Modifier ${source.url}`}
    >
      <Field
        label={source.type === "RSS" ? "URL du flux RSS" : "URL du site"}
        type="url"
        value={url}
        autoFocus
        disabled={busy}
        onChange={(event) => changeUrl(event.target.value)}
      />
      {hasTemplate && (
        <Field
          label="Modèle d'URL de pagination"
          value={template}
          disabled={busy}
          onChange={(event) => {
            setTemplateEdited(true);
            setTemplate(event.target.value);
            setError("");
          }}
          hint="Vérifiez l'adresse utilisée pour chaque page ; conservez {page} dans le modèle."
        />
      )}
      <Feedback message={error} error />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || unchanged}>
          {busy && <LoaderCircle className="animate-spin" />}
          {busy ? "Vérification et enregistrement…" : "Enregistrer les modifications"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
