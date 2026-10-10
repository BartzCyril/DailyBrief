import { useState, type FormEvent } from "react";
import type { SourcePreview } from "@dailybrief/shared";
import { useNavigate } from "react-router-dom";
import { LoaderCircle, Check } from "lucide-react";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { errorMessage } from "@/lib/api";
import { sourcesApi, validHttpUrl } from "./api";
import { ArticlePreview } from "./ArticlePreview";
import { RssArticleLinkField, validArticleLinkSelector } from "./RssArticleLinkField";
import { SelectorAssistance } from "./SelectorAssistance";
export function RssForm() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [articleLinkSelector, setArticleLinkSelector] = useState("");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const pending = !!busy || assistanceBusy;
  async function test(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError("");
    setPreview(null);
    if (!validHttpUrl(url)) {
      setError("Saisissez une URL HTTP ou HTTPS valide.");
      return;
    }
    if (!validArticleLinkSelector(articleLinkSelector)) {
      setError("Saisissez un sélecteur CSS valide pour le lien vers l'article.");
      return;
    }
    setBusy("test");
    try {
      setPreview(await sourcesApi.testRss(url, articleLinkSelector.trim() || undefined));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (!preview || pending) return;
    setBusy("save");
    setError("");
    try {
      await sourcesApi.saveRss(url, articleLinkSelector.trim() || undefined);
      navigate("/sources", { state: { message: "Flux RSS ajouté." } });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="space-y-6">
      <form onSubmit={test} className="space-y-4" noValidate>
        <Field
          label="URL du flux RSS"
          type="url"
          value={url}
          disabled={pending}
          onChange={(event) => {
            setUrl(event.target.value);
            setPreview(null);
            setError("");
          }}
          placeholder="https://example.com/feed.xml"
          required
        />
        <SelectorAssistance
          kind="RSS_LINK"
          url={url}
          disabled={!!busy}
          onBusyChange={setAssistanceBusy}
          onStart={() => {
            setPreview(null);
            setError("");
          }}
          onResult={(result) => {
            if (result.kind === "RSS_LINK") setArticleLinkSelector(result.articleLinkSelector);
          }}
        />
        <RssArticleLinkField
          value={articleLinkSelector}
          disabled={pending}
          onChange={(value) => {
            setArticleLinkSelector(value);
            setPreview(null);
            setError("");
          }}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending}>
            {busy === "test" && <LoaderCircle className="animate-spin" />}
            {busy === "test" ? "Test du flux en cours…" : "Tester"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!preview || pending}
            onClick={() => void save()}
          >
            {busy === "save" ? <LoaderCircle className="animate-spin" /> : <Check />}
            {busy === "save" ? "Enregistrement…" : "Enregistrer le flux"}
          </Button>
        </div>
      </form>
      <Feedback message={error} error />
      <Feedback message={preview?.warnings?.join(" ") ?? ""} />
      {preview && <ArticlePreview preview={preview} />}
    </div>
  );
}
