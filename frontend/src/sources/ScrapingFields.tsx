import type { ScrapingConfig } from "@dailybrief/shared";
import { Field } from "@/components/Field";
import { SelectField } from "@/components/SelectField";
export type ScrapingDraft = {
  articleSelector: string;
  titleSelector: string;
  linkSelector: string;
  descriptionSelector: string;
  dateSelector: string;
  mode: ScrapingConfig["mode"];
  buttonSelector: string;
  waitTimeoutMs: string;
  maxScrolls: string;
  waitAfterScrollMs: string;
  strategy: "QUERY_PARAM" | "URL_TEMPLATE";
  startPage: string;
  queryParam: string;
  urlTemplate: string;
};
export const defaultDraft: ScrapingDraft = {
  articleSelector: "",
  titleSelector: "",
  linkSelector: "",
  descriptionSelector: "",
  dateSelector: "",
  mode: "SCROLL",
  buttonSelector: "",
  waitTimeoutMs: "15000",
  maxScrolls: "3",
  waitAfterScrollMs: "1000",
  strategy: "QUERY_PARAM",
  startPage: "1",
  queryParam: "page",
  urlTemplate: "",
};
const numeric = (value: string) => (value.trim() ? Number(value) : NaN);
export function createScrapingDraft(config?: ScrapingConfig | null): ScrapingDraft {
  if (!config) return { ...defaultDraft };
  return {
    ...defaultDraft,
    articleSelector: config.articleSelector,
    titleSelector: config.titleSelector,
    linkSelector: config.linkSelector,
    descriptionSelector: config.descriptionSelector ?? "",
    dateSelector: config.dateSelector ?? "",
    mode: config.mode,
    buttonSelector: config.loadMore?.buttonSelector ?? "",
    waitTimeoutMs: String(config.loadMore?.waitTimeoutMs ?? defaultDraft.waitTimeoutMs),
    maxScrolls: String(config.scroll?.maxScrolls ?? defaultDraft.maxScrolls),
    waitAfterScrollMs: String(config.scroll?.waitAfterScrollMs ?? defaultDraft.waitAfterScrollMs),
    strategy: config.pagination?.strategy ?? defaultDraft.strategy,
    startPage: String(config.pagination?.startPage ?? defaultDraft.startPage),
    queryParam: config.pagination?.queryParam ?? defaultDraft.queryParam,
    urlTemplate: config.pagination?.urlTemplate ?? "",
  };
}
export function buildScrapingConfig(draft: ScrapingDraft): ScrapingConfig {
  return {
    articleSelector: draft.articleSelector,
    titleSelector: draft.titleSelector,
    linkSelector: draft.linkSelector,
    descriptionSelector: draft.descriptionSelector,
    dateSelector: draft.dateSelector,
    mode: draft.mode,
    ...(draft.mode === "SCROLL"
      ? {
          scroll: {
            maxScrolls: numeric(draft.maxScrolls),
            waitAfterScrollMs: numeric(draft.waitAfterScrollMs),
          },
        }
      : draft.mode === "LOAD_MORE"
        ? {
            loadMore: {
              buttonSelector: draft.buttonSelector,
              waitTimeoutMs: numeric(draft.waitTimeoutMs),
            },
          }
        : {
            pagination: {
              strategy: draft.strategy,
              startPage: numeric(draft.startPage),
              ...(draft.strategy === "QUERY_PARAM"
                ? { queryParam: draft.queryParam }
                : { urlTemplate: draft.urlTemplate }),
            },
          }),
  };
}
type Props = { draft: ScrapingDraft; update: (value: Partial<ScrapingDraft>) => void };
export function LoadMoreFields({ draft, update }: Props) {
  return (
    <div className="space-y-4">
      <Field
        label="Sélecteur du bouton"
        value={draft.buttonSelector}
        onChange={(event) => update({ buttonSelector: event.target.value })}
        placeholder=".load-more"
        hint="Sélecteur CSS du bouton qui affiche les articles suivants."
      />
      <Field
        label="Délai maximum après un clic (ms)"
        type="number"
        min={1000}
        max={60000}
        value={draft.waitTimeoutMs}
        onChange={(event) => update({ waitTimeoutMs: event.target.value })}
        hint="Temps laissé au site pour ajouter de nouveaux articles."
      />
      <p className="text-sm text-muted-foreground">
        Le bouton est cliqué jusqu'à ce qu'il disparaisse, soit désactivé ou n'ajoute plus
        d'articles.
      </p>
    </div>
  );
}
export function ScrollFields({ draft, update }: Props) {
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <Field
        label="Nombre maximum de scrolls"
        type="number"
        min={0}
        max={8}
        value={draft.maxScrolls}
        onChange={(event) => update({ maxScrolls: event.target.value })}
      />
      <Field
        label="Attente après un scroll (ms)"
        type="number"
        min={100}
        max={3000}
        value={draft.waitAfterScrollMs}
        onChange={(event) => update({ waitAfterScrollMs: event.target.value })}
      />
    </div>
  );
}
export function PaginationFields({ draft, update }: Props) {
  return (
    <div className="space-y-4">
      <SelectField
        label="Stratégie de pagination"
        value={draft.strategy}
        onChange={(value) =>
          update({ strategy: value === "URL_TEMPLATE" ? "URL_TEMPLATE" : "QUERY_PARAM" })
        }
        choices={[
          { value: "QUERY_PARAM", label: "Paramètre de l'URL" },
          { value: "URL_TEMPLATE", label: "Modèle d'URL" },
        ]}
      />
      {draft.strategy === "URL_TEMPLATE" ? (
        <Field
          label="Modèle d'URL"
          value={draft.urlTemplate}
          onChange={(event) => update({ urlTemplate: event.target.value })}
          placeholder="https://example.com/page/{page}"
          hint="{page} sera remplacé par le numéro de la page."
        />
      ) : (
        <Field
          label="Nom du paramètre"
          value={draft.queryParam}
          onChange={(event) => update({ queryParam: event.target.value })}
          placeholder="page"
          hint="Le paramètre sera ajouté à l'URL de départ."
        />
      )}
      <Field
        label="Page de départ"
        type="number"
        min={0}
        value={draft.startPage}
        onChange={(event) => update({ startPage: event.target.value })}
        hint="Certains sites commencent à la page 0."
      />
      <p className="text-sm text-muted-foreground">
        Toutes les pages sont parcourues jusqu'à une page sans article. Une page répétée arrête la
        pagination.
      </p>
    </div>
  );
}
export function ScrapingFields({ draft, update }: Props) {
  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 gap-4">
        {(
          [
            {
              key: "articleSelector",
              label: "Sélecteur des articles",
              placeholder: ".article-card",
              hint: "Bloc racine de chaque article.",
            },
            {
              key: "titleSelector",
              label: "Sélecteur du titre",
              placeholder: "h2",
              hint: "Sélecteur relatif au bloc article.",
            },
            {
              key: "linkSelector",
              label: "Sélecteur du lien",
              placeholder: "a",
              hint: "Le lien doit porter un attribut href.",
            },
            {
              key: "descriptionSelector",
              label: "Sélecteur de description",
              placeholder: ".description",
            },
            { key: "dateSelector", label: "Sélecteur de date", placeholder: "time" },
          ] as const
        ).map((field) => (
          <Field
            key={field.key}
            required
            label={field.label}
            value={draft[field.key]}
            placeholder={field.placeholder}
            hint={"hint" in field ? field.hint : undefined}
            onChange={(event) => update({ [field.key]: event.target.value })}
          />
        ))}
      </div>
      <SelectField
        label="Mode de récupération"
        value={draft.mode}
        onChange={(value) =>
          update({
            mode:
              value === "PAGINATE" ? "PAGINATE" : value === "LOAD_MORE" ? "LOAD_MORE" : "SCROLL",
          })
        }
        choices={[
          { value: "SCROLL", label: "Scroll infini" },
          { value: "PAGINATE", label: "Pagination" },
          { value: "LOAD_MORE", label: "Bouton charger plus" },
        ]}
      />
      {draft.mode === "SCROLL" ? (
        <ScrollFields draft={draft} update={update} />
      ) : draft.mode === "LOAD_MORE" ? (
        <LoadMoreFields draft={draft} update={update} />
      ) : (
        <PaginationFields draft={draft} update={update} />
      )}
    </div>
  );
}
