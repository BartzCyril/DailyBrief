import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { SourcePreview, ScrapingConfig } from "@dailybrief/shared";
import { scrapingSchema } from "../../../shared/src/scraping";
import { LoaderCircle, Check } from "lucide-react";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { errorMessage } from "@/lib/api";
import { sourcesApi, validHttpUrl } from "./api";
import { ArticlePreview } from "./ArticlePreview";
import {
  ScrapingFields,
  defaultDraft,
  buildScrapingConfig,
  createScrapingDraft,
  type ScrapingDraft,
} from "./ScrapingFields";
import { SelectorAssistance } from "./SelectorAssistance";
export function ScrapingForm() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState(defaultDraft);
  const [tested, setTested] = useState<{
    preview: SourcePreview;
    url: string;
    config: ScrapingConfig;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const pending = !!busy || assistanceBusy;
  function update(value: Partial<ScrapingDraft>) {
    setDraft((previous) => ({ ...previous, ...value }));
    setTested(null);
    setError("");
  }
  async function test(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError("");
    setTested(null);
    if (!validHttpUrl(url)) {
      setError("Saisissez une URL HTTP ou HTTPS valide.");
      return;
    }
    const validation = scrapingSchema.safeParse(buildScrapingConfig(draft));
    if (!validation.success) {
      setError(
        validation.error.issues.some((issue) => issue.path.includes("urlTemplate"))
          ? "Le modèle d'URL doit contenir {page}."
          : "Vérifiez les sélecteurs requis et les limites de collecte.",
      );
      return;
    }
    setBusy("test");
    try {
      const preview = await sourcesApi.testScraping(url, validation.data);
      setTested({ preview, url, config: validation.data });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (!tested || pending) return;
    setBusy("save");
    setError("");
    try {
      await sourcesApi.saveScraping(tested.url, tested.config);
      navigate("/sources", { state: { message: "Source de scraping ajoutée." } });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="space-y-6">
      <form onSubmit={test} noValidate className="space-y-5">
        <fieldset disabled={pending} className="space-y-5">
          <Field
            label="URL du site"
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setTested(null);
              setError("");
            }}
            placeholder="https://example.com/articles"
          />
        </fieldset>
        <SelectorAssistance
          kind="SCRAPING"
          url={url}
          disabled={!!busy}
          onBusyChange={setAssistanceBusy}
          onStart={() => {
            setTested(null);
            setError("");
          }}
          onResult={(result) => {
            if (result.kind === "SCRAPING") setDraft(createScrapingDraft(result.scrapingConfig));
          }}
        />
        <fieldset disabled={pending} className="space-y-5">
          <ScrapingFields draft={draft} update={update} />
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending}>
            {busy === "test" && <LoaderCircle className="animate-spin" />}
            {busy === "test" ? "Test du scraping en cours…" : "Tester"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!tested || pending}
            onClick={() => void save()}
          >
            {busy === "save" ? <LoaderCircle className="animate-spin" /> : <Check />}
            {busy === "save" ? "Enregistrement…" : "Enregistrer la source"}
          </Button>
        </div>
      </form>
      <Feedback message={error} error />
      <Feedback message={tested?.preview.warnings?.join(" ") ?? ""} />
      {tested && <ArticlePreview preview={tested.preview} />}
    </div>
  );
}
