import type { ScrapingConfig } from "@dailybrief/shared";
import { Field } from "@/components/Field";
import { SelectField } from "@/components/SelectField";
export type ScrapingDraft = {
  articleSelector: string;
  titleSelector: string;
  linkSelector: string;
  descriptionSelector: string;
  dateSelector: string;
  mode: "SCROLL" | "PAGINATE";
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
  maxScrolls: "3",
  waitAfterScrollMs: "1000",
  strategy: "QUERY_PARAM",
  startPage: "1",
  queryParam: "page",
  urlTemplate: "",
};
const numeric = (value: string) => (value.trim() ? Number(value) : NaN);
export function buildScrapingConfig(draft: ScrapingDraft): ScrapingConfig {
  return {
    articleSelector: draft.articleSelector,
    titleSelector: draft.titleSelector,
    linkSelector: draft.linkSelector,
    ...(draft.descriptionSelector ? { descriptionSelector: draft.descriptionSelector } : {}),
    ...(draft.dateSelector ? { dateSelector: draft.dateSelector } : {}),
    mode: draft.mode,
    ...(draft.mode === "SCROLL"
      ? {
          scroll: {
            maxScrolls: numeric(draft.maxScrolls),
            waitAfterScrollMs: numeric(draft.waitAfterScrollMs),
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
              label: "Sélecteur de description (facultatif)",
              placeholder: ".description",
            },
            { key: "dateSelector", label: "Sélecteur de date (facultatif)", placeholder: "time" },
          ] as const
        ).map((field) => (
          <Field
            key={field.key}
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
        onChange={(value) => update({ mode: value === "PAGINATE" ? "PAGINATE" : "SCROLL" })}
        choices={[
          { value: "SCROLL", label: "Scroll infini" },
          { value: "PAGINATE", label: "Pagination" },
        ]}
      />
      {draft.mode === "SCROLL" ? (
        <ScrollFields draft={draft} update={update} />
      ) : (
        <PaginationFields draft={draft} update={update} />
      )}
    </div>
  );
}
