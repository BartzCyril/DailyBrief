import { useState, type FormEvent } from "react";
import type { Source, ScrapingConfig, SourcePreview } from "@dailybrief/shared";
import { scrapingSchema } from "../../../shared/src/scraping";
import { LoaderCircle } from "lucide-react";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { errorMessage } from "@/lib/api";
import { sourcesApi, validHttpUrl } from "./api";
import { ArticlePreview } from "./ArticlePreview";
import { RssArticleLinkField, validArticleLinkSelector } from "./RssArticleLinkField";
import { SelectorAssistance } from "./SelectorAssistance";
import {
  ScrapingFields,
  createScrapingDraft,
  buildScrapingConfig,
  type ScrapingDraft,
} from "./ScrapingFields";

export function EditSourceForm({
  source,
  busy,
  onSave,
  onCancel,
  onBlockingChange,
}: {
  source: Source;
  busy: boolean;
  onSave: (
    url: string,
    config?: ScrapingConfig,
    articleLinkSelector?: string | null,
  ) => Promise<void>;
  onCancel: () => void;
  onBlockingChange?: (blocked: boolean) => void;
}) {
  const [url, setUrl] = useState(source.url);
  const [articleLinkSelector, setArticleLinkSelector] = useState(source.articleLinkSelector ?? "");
  const [draft, setDraft] = useState(() => createScrapingDraft(source.scrapingConfig));
  const [templateEdited, setTemplateEdited] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const pending = busy || testing || assistanceBusy;
  const unchanged =
    url.trim() === source.url &&
    (source.type === "RSS"
      ? articleLinkSelector.trim() === (source.articleLinkSelector ?? "")
      : JSON.stringify(buildScrapingConfig(draft)) ===
        JSON.stringify(buildScrapingConfig(createScrapingDraft(source.scrapingConfig))));
  function update(value: Partial<ScrapingDraft>) {
    if (value.urlTemplate !== undefined) setTemplateEdited(true);
    setDraft((previous) => ({ ...previous, ...value }));
    setPreview(null);
    setError("");
  }
  function changeUrl(value: string) {
    const originalTemplate = source.scrapingConfig?.pagination?.urlTemplate ?? "";
    const suffix = originalTemplate.slice(source.url.length);
    if (
      draft.mode === "PAGINATE" &&
      draft.strategy === "URL_TEMPLATE" &&
      !templateEdited &&
      originalTemplate.startsWith(source.url) &&
      (source.url.endsWith("/") || !suffix || "/?&#".includes(suffix[0]!))
    )
      setDraft((previous) => ({ ...previous, urlTemplate: value + suffix }));
    setUrl(value);
    setPreview(null);
    setError("");
  }
  function validate(): {
    url: string;
    config?: ScrapingConfig;
    articleLinkSelector?: string | null;
  } | null {
    setError("");
    if (!validHttpUrl(url.trim())) {
      setError("Saisissez une URL HTTP ou HTTPS valide.");
      return null;
    }
    if (source.type === "RSS") {
      if (!validArticleLinkSelector(articleLinkSelector)) {
        setError("Saisissez un sélecteur CSS valide pour le lien vers l'article.");
        return null;
      }
      return {
        url: url.trim(),
        articleLinkSelector:
          articleLinkSelector.trim() || (source.articleLinkSelector ? null : undefined),
      };
    }
    const validation = scrapingSchema.safeParse(buildScrapingConfig(draft));
    if (!validation.success) {
      setError(
        validation.error.issues.some((issue) => issue.path.includes("urlTemplate"))
          ? "Le modèle d'URL doit contenir {page}."
          : "Vérifiez les sélecteurs requis et les paramètres de collecte.",
      );
      return null;
    }
    if (
      validation.data.mode === "PAGINATE" &&
      validation.data.pagination?.strategy === "URL_TEMPLATE" &&
      !validHttpUrl(validation.data.pagination.urlTemplate!.replaceAll("{page}", "0"))
    ) {
      setError("Le modèle d'URL doit être une URL HTTP ou HTTPS contenant {page}.");
      return null;
    }
    return { url: url.trim(), config: validation.data };
  }
  async function test() {
    if (pending) return;
    const input = validate();
    if (!input) return;
    setTesting(true);
    setPreview(null);
    try {
      setPreview(
        input.config
          ? await sourcesApi.testScraping(input.url, input.config)
          : await sourcesApi.testRss(input.url, input.articleLinkSelector),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || unchanged) return;
    const input = validate();
    if (input) await onSave(input.url, input.config, input.articleLinkSelector);
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="w-full space-y-5"
      aria-label={`Modifier ${source.url}`}
    >
      <fieldset disabled={pending} className="space-y-5 min-w-0">
        <Field
          label={source.type === "RSS" ? "URL du flux RSS" : "URL du site"}
          type="url"
          value={url}
          autoFocus
          onChange={(event) => changeUrl(event.target.value)}
        />
      </fieldset>
      <SelectorAssistance
        kind={source.type === "RSS" ? "RSS_LINK" : "SCRAPING"}
        url={url}
        disabled={busy || testing}
        onBusyChange={setAssistanceBusy}
        onPendingChange={(pending) => onBlockingChange?.(pending === "help")}
        onStart={() => {
          setPreview(null);
          setError("");
        }}
        onResult={(result) => {
          if (result.kind === "RSS_LINK") setArticleLinkSelector(result.articleLinkSelector);
          else if (result.kind === "SCRAPING") {
            setDraft(createScrapingDraft(result.scrapingConfig));
            setTemplateEdited(false);
          }
        }}
      />
      <fieldset disabled={pending} className="space-y-5 min-w-0">
        {source.type === "SCRAPING" ? (
          <ScrapingFields draft={draft} update={update} />
        ) : (
          <RssArticleLinkField
            value={articleLinkSelector}
            onChange={(value) => {
              setArticleLinkSelector(value);
              setPreview(null);
              setError("");
            }}
          />
        )}
      </fieldset>
      <Feedback message={error} error />
      <Feedback message={preview?.warnings?.join(" ") ?? ""} />
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" disabled={pending} onClick={() => void test()}>
          {testing && <LoaderCircle className="animate-spin" />}
          {testing ? "Test en cours…" : "Tester"}
        </Button>
        <Button type="submit" disabled={pending || unchanged}>
          {busy && <LoaderCircle className="animate-spin" />}
          {busy ? "Vérification et enregistrement…" : "Enregistrer les modifications"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Annuler
        </Button>
      </div>
      {preview && <ArticlePreview preview={preview} />}
    </form>
  );
}
