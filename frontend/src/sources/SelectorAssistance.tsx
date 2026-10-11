import { useEffect, useRef, useState } from "react";
import type { SelectorAnalysisInput, SelectorAnalysisResponse } from "@dailybrief/shared";
import { LoaderCircle, Mail, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { api, ApiError, errorMessage } from "@/lib/api";
import { validHttpUrl } from "./api";

function hasRequiredSelectors(result: SelectorAnalysisResponse) {
  const fields =
    result.kind === "RSS_LINK"
      ? [result.articleLinkSelector]
      : result.kind === "JOURNAL_LOGIN"
        ? [
            result.loginConfig.loginUrl,
            result.loginConfig.emailSelector,
            result.loginConfig.passwordSelector,
            result.loginConfig.submitSelector,
          ]
        : [
            result.scrapingConfig.articleSelector,
            result.scrapingConfig.titleSelector,
            result.scrapingConfig.linkSelector,
            result.scrapingConfig.descriptionSelector,
            result.scrapingConfig.dateSelector,
          ];
  return fields.every((field) => typeof field === "string" && !!field.trim());
}

export type SelectorAssistancePending = "analysis" | "help" | null;

/** Only the public URL and analysis type leave the browser, never form credentials. */
export function SelectorAssistance({
  kind,
  url,
  disabled = false,
  onStart,
  onResult,
  onBusyChange,
  onPendingChange,
}: SelectorAnalysisInput & {
  disabled?: boolean;
  onStart?: () => void;
  onResult: (result: SelectorAnalysisResponse) => void;
  onBusyChange?: (busy: boolean) => void;
  onPendingChange?: (pending: SelectorAssistancePending) => void;
}) {
  const [pending, setPending] = useState<SelectorAssistancePending>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [helpRequestId, setHelpRequestId] = useState<string>();
  const [helpSent, setHelpSent] = useState(false);
  const currentRequest = useRef<AbortController | null>(null);
  const context = useRef({ kind, url });
  context.current = { kind, url };
  const callbacks = useRef({ onStart, onResult, onBusyChange, onPendingChange });
  callbacks.current = { onStart, onResult, onBusyChange, onPendingChange };

  useEffect(() => {
    setPending(null);
    setMessage("");
    setError("");
    setHelpRequestId(undefined);
    setHelpSent(false);
    return () => {
      currentRequest.current?.abort();
      currentRequest.current = null;
      callbacks.current.onBusyChange?.(false);
      callbacks.current.onPendingChange?.(null);
    };
  }, [kind, url]);

  function cancelAnalysis() {
    if (pending !== "analysis") return;
    currentRequest.current?.abort();
    currentRequest.current = null;
    setPending(null);
    setError("");
    setMessage("Analyse annulée.");
    callbacks.current.onBusyChange?.(false);
    callbacks.current.onPendingChange?.(null);
  }

  async function run(action: "analysis" | "help") {
    if (currentRequest.current || disabled || (action === "help" && (!helpRequestId || helpSent)))
      return;
    if (action === "analysis" && !validHttpUrl(url.trim())) {
      setError("Saisissez d'abord une URL HTTP ou HTTPS valide.");
      return;
    }
    const controller = new AbortController();
    const requestContext = context.current;
    const obsolete = () =>
      controller.signal.aborted ||
      requestContext.kind !== context.current.kind ||
      requestContext.url !== context.current.url;
    currentRequest.current = controller;
    setPending(action);
    callbacks.current.onBusyChange?.(true);
    callbacks.current.onPendingChange?.(action);
    setError("");
    if (action === "analysis") {
      setMessage("");
      setHelpRequestId(undefined);
      setHelpSent(false);
      callbacks.current.onStart?.();
    }
    try {
      if (action === "analysis") {
        const result = await api<SelectorAnalysisResponse>("/ai/selectors/analyze", {
          method: "POST",
          body: { kind, url: url.trim() },
          signal: controller.signal,
        });
        if (obsolete()) return;
        if (result.kind !== kind)
          throw new Error("L'analyse reçue ne correspond pas à ce formulaire.");
        callbacks.current.onResult(result);
        if (hasRequiredSelectors(result)) {
          setMessage(
            result.kind === "SCRAPING" && result.retrievalConfirmed === false
              ? "Sélecteurs remplis. Vérifiez le mode de récupération."
              : "Sélecteurs remplis.",
          );
          setHelpRequestId(undefined);
        } else {
          setError("Certains sélecteurs n'ont pas pu être remplis.");
          setHelpRequestId(result.helpRequestId);
        }
      } else {
        await api<{ message: string }>("/ai/selectors/help", {
          method: "POST",
          body: { helpRequestId },
          signal: controller.signal,
        });
        if (obsolete()) return;
        setError("");
        setMessage("Demande d'aide envoyée.");
        setHelpSent(true);
      }
    } catch (error) {
      if (obsolete()) return;
      setError(errorMessage(error));
      if (action === "analysis" && error instanceof ApiError) setHelpRequestId(error.helpRequestId);
    } finally {
      if (currentRequest.current === controller) {
        currentRequest.current = null;
        setPending(null);
        callbacks.current.onBusyChange?.(false);
        callbacks.current.onPendingChange?.(null);
      }
    }
  }

  return (
    <div className="space-y-3" aria-label="Assistance pour les sélecteurs" aria-busy={!!pending}>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !!pending || !url.trim()}
          onClick={() => void run("analysis")}
        >
          {pending === "analysis" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
          {pending === "analysis" ? "Analyse en cours…" : "Remplir avec l'IA"}
        </Button>
        {pending === "analysis" && (
          <Button type="button" variant="outline" autoFocus onClick={cancelAnalysis}>
            <X aria-hidden="true" />
            Annuler l'analyse
          </Button>
        )}
        {helpRequestId && !helpSent && (
          <Button
            type="button"
            variant="outline"
            disabled={disabled || !!pending}
            onClick={() => void run("help")}
          >
            {pending === "help" ? <LoaderCircle className="animate-spin" /> : <Mail />}
            {pending === "help" ? "Envoi en cours…" : "Demander de l'aide"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Vérifiez les champs avant d'enregistrer.</p>
      {helpRequestId && !helpSent && (
        <p className="text-xs text-muted-foreground">
          Envoie le site et les sélecteurs manquants à l'administrateur, sans vos identifiants.
        </p>
      )}
      <Feedback message={error} error />
      <Feedback message={message} />
    </div>
  );
}
